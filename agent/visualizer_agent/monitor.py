"""sys.monitoring (PEP 669, Python 3.12+) function tracer.

We claim the profiler tool slot once and arm *individual code objects* with local
PY_START/PY_RETURN events, so an unselected function costs nothing. Two levels per function:
  * shallow -- record just that call (args in, value/exception out, duration)
  * deep    -- while it runs, also record every nested call under the package root (global
               events, ref-counted across in-flight deep frames)
Parenting uses a ContextVar (not frame.f_back) so asyncio fan-out and threadpool handlers nest
correctly; every event goes to the current request's collector (``trace._active``).
"""
from __future__ import annotations

import importlib
import inspect
import logging
import os
import secrets
import sys
import threading
import time
import traceback as _tb
from contextvars import ContextVar
from pathlib import Path
from types import CodeType, FrameType
from typing import Any

from . import trace

logger = logging.getLogger("uvicorn.error")
_TOOL_NAME = "visualizer-agent"
_SELF_DIR = os.path.normcase(os.path.abspath(os.path.dirname(__file__)))
_SELF_MODULE = __name__.rsplit(".", 1)[0]          # "visualizer_agent"

# set by configure()
_package_root = ""
_project_root = ""

_lock = threading.Lock()
_installed = False
_armed: dict[CodeType, str] = {}           # code -> "shallow" | "deep"
_code_to_id: dict[CodeType, str] = {}      # code -> "module:qualname"
_current_global_mask = 0
_deep_refcount = 0
_frames: dict[int, dict[str, Any]] = {}    # id(frame) -> record
_current_parent: ContextVar[dict[str, Any] | None] = ContextVar("_viz_current_parent", default=None)
_reentry = threading.local()
_FILE_OK: dict[str, bool] = {}


def configure(*, package_root: Path | str, project_root: Path | str) -> None:
    global _package_root, _project_root
    _package_root = os.path.normcase(os.path.abspath(str(package_root)))
    _project_root = os.path.abspath(str(project_root))
    _FILE_OK.clear()


def is_supported() -> bool:
    return hasattr(sys, "monitoring") and hasattr(sys.monitoring, "PROFILER_ID")


def install() -> bool:
    global _installed
    if _installed:
        return True
    if not is_supported():
        logger.warning("visualizer: sys.monitoring unavailable (need Python 3.12+) -- function tracing off")
        return False
    mon = sys.monitoring
    held = mon.get_tool(mon.PROFILER_ID)
    if held is None:
        mon.use_tool_id(mon.PROFILER_ID, _TOOL_NAME)
    elif held != _TOOL_NAME:
        logger.warning("visualizer: sys.monitoring profiler slot held by %r -- function tracing off", held)
        return False
    mon.register_callback(mon.PROFILER_ID, mon.events.PY_START, _cb_start)
    mon.register_callback(mon.PROFILER_ID, mon.events.PY_RETURN, _cb_return)
    mon.register_callback(mon.PROFILER_ID, mon.events.PY_UNWIND, _cb_unwind)
    _installed = True
    return True


def uninstall() -> None:
    global _installed, _current_global_mask, _deep_refcount
    if not _installed:
        return
    mon = sys.monitoring
    with _lock:
        for code in list(_armed):
            try:
                mon.set_local_events(mon.PROFILER_ID, code, 0)
            except Exception:  # noqa: BLE001
                pass
        _armed.clear()
        _code_to_id.clear()
    mon.set_events(mon.PROFILER_ID, 0)
    for event in (mon.events.PY_START, mon.events.PY_RETURN, mon.events.PY_UNWIND):
        mon.register_callback(mon.PROFILER_ID, event, None)
    mon.free_tool_id(mon.PROFILER_ID)
    _installed = False
    _current_global_mask = 0
    _deep_refcount = 0
    _frames.clear()


def _recompute_global_events() -> None:
    """PY_UNWIND is global-only (PEP 669): on while anything is armed; deep frames add
    PY_START|PY_RETURN. Call with _lock held."""
    global _current_global_mask
    ev = sys.monitoring.events
    mask = 0
    if _armed:
        mask |= ev.PY_UNWIND
    if _deep_refcount > 0:
        mask |= ev.PY_START | ev.PY_RETURN | ev.PY_UNWIND
    if mask != _current_global_mask:
        sys.monitoring.set_events(sys.monitoring.PROFILER_ID, mask)
        _current_global_mask = mask


def _resolve_code(id_str: str) -> CodeType:
    module_path, sep, qualname = id_str.partition(":")
    if not sep or not module_path or not qualname:
        raise ValueError("id must be 'module:qualname'")
    if module_path == _SELF_MODULE or module_path.startswith(_SELF_MODULE + "."):
        raise ValueError("cannot trace the tracer itself")
    module = importlib.import_module(module_path)
    obj: Any = module
    for part in qualname.split("."):
        if part == "<locals>":
            raise ValueError("cannot arm a nested/closure function")
        obj = getattr(obj, part)
    if isinstance(obj, (staticmethod, classmethod)):
        obj = obj.__func__
    if inspect.ismethod(obj):
        obj = obj.__func__
    obj = inspect.unwrap(obj)
    code = getattr(obj, "__code__", None)
    if not isinstance(code, CodeType):
        raise TypeError(f"{id_str!r} resolved to {type(obj).__name__}, not a Python function")
    return code


def apply_selection(selections: list[dict[str, Any]]) -> dict[str, Any]:
    """``[{"id": "module:qualname", "deep": bool}]``: arms exactly that set, disarming the rest.
    Returns {"armed": [id], "unresolved": [{"id","reason"}], "count": n}."""
    if not install():
        return {"armed": [], "count": 0,
                "unresolved": [{"id": s.get("id"), "reason": "sys.monitoring unavailable"} for s in selections]}
    wanted: dict[CodeType, tuple[str, str]] = {}
    unresolved: list[dict[str, str]] = []
    for sel in selections:
        sid = str(sel.get("id", ""))
        try:
            code = _resolve_code(sid)
        except Exception as exc:  # noqa: BLE001 - report, don't raise
            unresolved.append({"id": sid, "reason": f"{type(exc).__name__}: {exc}"})
            continue
        wanted[code] = (sid, "deep" if sel.get("deep") else "shallow")
    mon = sys.monitoring
    local_mask = mon.events.PY_START | mon.events.PY_RETURN
    armed_ok: list[str] = []
    with _lock:
        for code in list(_armed):
            if code not in wanted:
                try:
                    mon.set_local_events(mon.PROFILER_ID, code, 0)
                except Exception:  # noqa: BLE001
                    pass
                _armed.pop(code, None)
                _code_to_id.pop(code, None)
        for code, (sid, level) in wanted.items():
            try:
                mon.set_local_events(mon.PROFILER_ID, code, local_mask)
                _armed[code] = level
                _code_to_id[code] = sid
                armed_ok.append(sid)
            except Exception as exc:  # noqa: BLE001
                unresolved.append({"id": sid, "reason": f"arm failed: {exc}"})
        _recompute_global_events()
    return {"armed": armed_ok, "unresolved": unresolved, "count": len(_armed)}


def status() -> dict[str, Any]:
    with _lock:
        armed = [{"id": _code_to_id.get(c, "?"), "level": lvl} for c, lvl in _armed.items()]
    return {"installed": _installed, "supported": is_supported(), "armed": armed, "deep_active": _deep_refcount > 0}


def on_request_end(collector: trace.TraceCollector) -> None:
    for fid in [fid for fid, rec in list(_frames.items()) if rec["collector"] is collector]:
        _frames.pop(fid, None)


# ── callbacks ──────────────────────────────────────────────────────────
def _cb_start(code: CodeType, instruction_offset: int) -> object:
    if getattr(_reentry, "on", False):
        return None
    collector = trace._active.get()
    if collector is None:
        return None
    armed_level = _armed.get(code)
    if armed_level is None:
        if _deep_refcount <= 0 or not _under_package(code.co_filename) or _in_agent(code.co_filename):
            return None
    _reentry.on = True
    try:
        frame = sys._getframe(1)
        parent = _current_parent.get()
        if parent is not None and parent["collector"] is not collector:
            parent = None  # stale value from another request's context
        module = frame.f_globals.get("__name__", "") or ""
        qualname = getattr(code, "co_qualname", code.co_name)
        label = f"{module}:{qualname}"
        record, capture = collector.admit(label)
        if not record:
            return None
        span_id = "sp_" + secrets.token_hex(4)
        depth = 0 if parent is None else parent["depth"] + 1
        parent_span_id = None if parent is None else parent["span_id"]
        _frames[id(frame)] = {
            "span_id": span_id, "parent_span_id": parent_span_id, "depth": depth, "collector": collector,
            "start": time.perf_counter(), "label": label, "deep": armed_level == "deep", "capture": capture,
            "parent_token": _current_parent.set({"span_id": span_id, "depth": depth, "collector": collector}),
        }
        try:
            collector.emit_call_start(span_id=span_id, parent_span_id=parent_span_id, depth=depth, label=label,
                                      qualname=qualname, module=module, file=_display_path(code.co_filename),
                                      line=code.co_firstlineno,
                                      args=_capture_args(frame, code) if capture else None)
        except Exception:  # noqa: BLE001 - a bad serialize must not break the traced code
            pass
        if armed_level == "deep":
            _enter_deep()
    finally:
        _reentry.on = False
    return None


def _cb_return(code: CodeType, instruction_offset: int, retval: object) -> None:
    _finish(sys._getframe(1), retval=retval, exc=None)


def _cb_unwind(code: CodeType, instruction_offset: int, exception: BaseException) -> None:
    _finish(sys._getframe(1), retval=None, exc=exception)


def _finish(frame: FrameType, *, retval: object, exc: BaseException | None) -> None:
    if getattr(_reentry, "on", False):
        return
    rec = _frames.pop(id(frame), None)
    if rec is None:
        return
    _reentry.on = True
    try:
        duration_ms = int((time.perf_counter() - rec["start"]) * 1000)
        collector: trace.TraceCollector = rec["collector"]
        try:
            if exc is not None:
                collector.emit_call_error(
                    span_id=rec["span_id"], parent_span_id=rec["parent_span_id"], depth=rec["depth"],
                    label=rec["label"], duration_ms=duration_ms, exc_type=type(exc).__name__, message=str(exc),
                    traceback="".join(_tb.format_exception(type(exc), exc, exc.__traceback__)))
            else:
                collector.emit_call_end(
                    span_id=rec["span_id"], parent_span_id=rec["parent_span_id"], depth=rec["depth"],
                    label=rec["label"], duration_ms=duration_ms, retval=retval, capture=rec["capture"])
        except Exception:  # noqa: BLE001
            pass
        try:
            _current_parent.reset(rec["parent_token"])
        except ValueError:
            pass
        if rec["deep"]:
            _exit_deep()
    finally:
        _reentry.on = False


def _enter_deep() -> None:
    global _deep_refcount
    with _lock:
        _deep_refcount += 1
        _recompute_global_events()


def _exit_deep() -> None:
    global _deep_refcount
    with _lock:
        _deep_refcount = max(0, _deep_refcount - 1)
        _recompute_global_events()


def _capture_args(frame: FrameType, code: CodeType) -> dict[str, Any]:
    n = code.co_argcount + code.co_kwonlyargcount
    f_locals = frame.f_locals
    return {name: f_locals[name] for name in code.co_varnames[:n] if name in f_locals}


def _under_package(filename: str) -> bool:
    ok = _FILE_OK.get(filename)
    if ok is None:
        try:
            ok = bool(_package_root) and os.path.normcase(os.path.abspath(filename)).startswith(_package_root)
        except Exception:  # noqa: BLE001
            ok = False
        _FILE_OK[filename] = ok
    return ok


def _in_agent(filename: str) -> bool:
    try:
        return os.path.normcase(os.path.abspath(filename)).startswith(_SELF_DIR)
    except Exception:  # noqa: BLE001
        return False


def _display_path(filename: str) -> str:
    try:
        absolute = os.path.abspath(filename)
        if _project_root and os.path.normcase(absolute).startswith(os.path.normcase(_project_root)):
            return os.path.relpath(absolute, _project_root).replace("\\", "/")
    except Exception:  # noqa: BLE001
        pass
    return filename

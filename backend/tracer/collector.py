"""backend/tracer/collector.py — accumulates one call tree from a stream of
sys.monitoring events.

The monitor module (backend/tracer/monitor.py) owns the process-global
sys.monitoring registration and routes each PY_START / PY_RETURN / PY_UNWIND
to the one active collector. This class holds no global state — it just
turns those three callbacks into a nested list of TraceCall.

Parenting is decided at PY_START by walking `frame.f_back` until we hit a
frame we're already tracking. That is correct even for interleaved async
work, because a coroutine's first steps always run synchronously inside the
frame that awaited it — so at PY_START the f_back chain still reflects the
real logical parent. Returns/unwinds are matched back to their start by
frame identity, which CPython keeps stable across await suspend/resume.
"""

from __future__ import annotations

import os
from time import perf_counter
from types import CodeType, FrameType
from typing import Any

from backend.tracer.models import TraceCall, TraceRecord
from backend.runner.serializer import safe_serialize

# filename -> is it under the trace root. co_filename strings are interned
# per code object and the set of files is tiny, so this makes should_trace
# O(1) after warmup and avoids a path normalization per call.
_FILE_UNDER_ROOT: dict[str, bool] = {}


class _Node:
    __slots__ = ("call", "start", "frame")

    def __init__(self, call: TraceCall, start: float, frame: FrameType) -> None:
        self.call = call
        self.start = start
        self.frame = frame  # held so its id() can't be reused while tracked


class TraceCollector:
    def __init__(
        self,
        *,
        trace_root: str,
        project_path: str,
        max_calls: int = 20000,
        max_depth: int = 60,
        value_max_depth: int = 4,
        max_items: int = 50,
        max_string_length: int = 2000,
    ) -> None:
        self._trace_root = _normcase_abspath(trace_root)
        self._project_path = _normcase_abspath(project_path)
        self._project_path_raw = os.path.abspath(project_path)
        self.max_calls = max_calls
        self.max_depth = max_depth
        self._value_kwargs = dict(
            max_depth=value_max_depth,
            max_items=max_items,
            max_string_length=max_string_length,
            expand_objects=False,
        )

        self.roots: list[TraceCall] = []
        self.call_count = 0
        self.truncated = False
        self._by_frame_id: dict[int, _Node] = {}
        self._next_id = 0

    # -- sys.monitoring routing -------------------------------------------------

    def should_trace(self, code: CodeType) -> bool:
        filename = code.co_filename
        cached = _FILE_UNDER_ROOT.get(filename)
        if cached is None:
            try:
                cached = _normcase_abspath(filename).startswith(self._trace_root)
            except Exception:
                cached = False
            _FILE_UNDER_ROOT[filename] = cached
        return cached

    def on_start(self, frame: FrameType, code: CodeType) -> None:
        parent = self._find_parent(frame)
        depth = 0 if parent is None else parent.call.depth + 1

        if self.call_count >= self.max_calls:
            self.truncated = True
            if parent is not None:
                parent.call.children_truncated = True
            return
        if depth > self.max_depth:
            if parent is not None:
                parent.call.children_truncated = True
            return

        self._next_id += 1
        call = TraceCall(
            call_id=self._next_id,
            qualname=getattr(code, "co_qualname", code.co_name),
            module=frame.f_globals.get("__name__", ""),
            file=self._display_path(code.co_filename),
            line=code.co_firstlineno,
            args=self._capture_args(frame, code),
            depth=depth,
        )
        self.call_count += 1
        if parent is None:
            self.roots.append(call)
        else:
            parent.call.children.append(call)
        self._by_frame_id[id(frame)] = _Node(call, perf_counter(), frame)

    def on_return(self, frame: FrameType, retval: Any) -> None:
        node = self._by_frame_id.pop(id(frame), None)
        if node is None:
            return
        node.call.duration_ms = (perf_counter() - node.start) * 1000
        node.call.return_value = self._serialize(retval)
        node.call.returned = True

    def on_unwind(self, frame: FrameType, exc: BaseException) -> None:
        node = self._by_frame_id.pop(id(frame), None)
        if node is None:
            return
        node.call.duration_ms = (perf_counter() - node.start) * 1000
        node.call.exception = f"{type(exc).__name__}: {exc}"

    # -- output -------------------------------------------------------------

    def build_record(
        self,
        *,
        trace_id: str,
        kind: str,
        label: str,
        started_at: str,
        duration_ms: float,
        method: str | None = None,
        path: str | None = None,
        status_code: int | None = None,
        error: str | None = None,
    ) -> TraceRecord:
        return TraceRecord(
            trace_id=trace_id,
            kind=kind,
            label=label,
            method=method,
            path=path,
            status_code=status_code,
            started_at=started_at,
            duration_ms=duration_ms,
            call_count=self.call_count,
            truncated=self.truncated,
            error=error,
            roots=self.roots,
        )

    # -- helpers -------------------------------------------------------------

    def _find_parent(self, frame: FrameType) -> _Node | None:
        pf = frame.f_back
        while pf is not None:
            node = self._by_frame_id.get(id(pf))
            if node is not None:
                return node
            pf = pf.f_back
        return None

    def _capture_args(self, frame: FrameType, code: CodeType) -> dict[str, Any]:
        n_args = code.co_argcount + code.co_kwonlyargcount
        names = list(code.co_varnames[:n_args])
        flags = code.co_flags
        if flags & 0x04:  # CO_VARARGS
            names.append(code.co_varnames[n_args])
        if flags & 0x08:  # CO_VARKEYWORDS
            names.append(code.co_varnames[n_args + (1 if flags & 0x04 else 0)])

        f_locals = frame.f_locals
        out: dict[str, Any] = {}
        for name in names:
            if name not in f_locals:
                continue
            value = f_locals[name]
            if name in ("self", "cls"):
                out[name] = _summarize_receiver(value)
            else:
                out[name] = self._serialize(value)
        return out

    def _serialize(self, value: Any) -> Any:
        try:
            return safe_serialize(value, **self._value_kwargs)
        except Exception as exc:  # serializer is defensive, but never fail a trace
            return f"<unserializable: {type(exc).__name__}: {exc}>"

    def _display_path(self, filename: str) -> str:
        try:
            norm = _normcase_abspath(filename)
        except Exception:
            return filename
        if norm.startswith(self._project_path):
            rel = os.path.relpath(os.path.abspath(filename), self._project_path_raw)
            return rel.replace("\\", "/")
        return filename


def _normcase_abspath(path: str) -> str:
    return os.path.normcase(os.path.abspath(path))


def _summarize_receiver(value: Any) -> str:
    cls = type(value)
    if cls.__name__ == "type":  # `cls` argument
        return f"<class {getattr(value, '__name__', value)!r}>"
    return f"<{cls.__module__}.{cls.__qualname__} instance>"

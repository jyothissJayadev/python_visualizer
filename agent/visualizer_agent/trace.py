"""Per-request trace collection, value serialization and a thread-safe event hub.

Design notes:
  * ``TraceHub.publish`` may run on any thread (sync FastAPI handlers run in a threadpool);
    subscribers are fed with ``loop.call_soon_threadsafe`` because ``asyncio.Queue`` is not
    thread-safe.
  * Replay history is kept per request and evicted whole-request-first, so a large request
    never loses its start/root spans.
  * Values are summarised, not deep-copied: register a summariser for big domain objects
    (``register_summarizer``), and only the first N calls of a function per request have their
    arguments/results serialized at all.
"""
from __future__ import annotations

import asyncio
import dataclasses
import itertools
import json
import re
import secrets
import threading
import time
from collections import OrderedDict, deque
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Callable, Iterator

_PREVIEW_MAX = 600
_FULL_MAX_DEPTH = 6
_FULL_MAX_ITEMS = 200
_RING_PER_REQUEST = 400
_RECENT_REQUESTS = 32
_TAIL_EVENTS = 12000
_SUBSCRIBER_MAX_PENDING = 20_000

_SECRET_KEY_RE = re.compile(r"(pass|pwd|secret|token|api[_-]?key|apikey|authorization|bearer|cookie|credential)", re.I)
_seq = itertools.count(1)


class Config:
    """Mutable module config, set by ``install``."""
    max_spans_per_request = 5000
    full_capture_per_fn = 50


CONFIG = Config()

# ── value serialization ─────────────────────────────────────────────────
_SUMMARIZERS: dict[str, Callable[[Any], Any]] = {}


def register_summarizer(type_or_name: type | str, fn: Callable[[Any], Any]) -> None:
    """Summarise objects of this type (matched by class name, so subclasses need their own)
    into something small and JSON-able instead of walking their fields."""
    name = type_or_name if isinstance(type_or_name, str) else type_or_name.__name__
    _SUMMARIZERS[name] = fn


def to_jsonable(value: Any, depth: int = 0) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value if len(value) <= 2000 else value[:2000] + f"…(+{len(value) - 2000} chars)"
    if depth >= _FULL_MAX_DEPTH:
        return f"«{type(value).__name__}: depth limit»"
    summarizer = _SUMMARIZERS.get(type(value).__name__)
    if summarizer is not None:
        try:
            return summarizer(value)
        except Exception:  # noqa: BLE001
            pass
    if isinstance(value, dict):
        out, items = {}, list(value.items())
        for k, v in items[:_FULL_MAX_ITEMS]:
            key = k if isinstance(k, str) else str(k)
            out[key] = "«redacted»" if _SECRET_KEY_RE.search(key) else to_jsonable(v, depth + 1)
        if len(items) > _FULL_MAX_ITEMS:
            out["…"] = f"+{len(items) - _FULL_MAX_ITEMS} more"
        return out
    if isinstance(value, (list, tuple, set, frozenset, deque)):
        seq = list(value)
        out = [to_jsonable(v, depth + 1) for v in seq[:_FULL_MAX_ITEMS]]
        if len(seq) > _FULL_MAX_ITEMS:
            out.append(f"…+{len(seq) - _FULL_MAX_ITEMS} more")
        return out
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        out = {"_type": type(value).__name__}
        for f in dataclasses.fields(value)[:_FULL_MAX_ITEMS]:
            out[f.name] = to_jsonable(getattr(value, f.name, None), depth + 1)
        return out
    if isinstance(value, (bytes, bytearray)):
        return f"«{len(value)} bytes»"
    if isinstance(value, BaseException):
        return f"{type(value).__name__}: {value}"
    model_dump = getattr(value, "model_dump", None)          # pydantic v2
    if callable(model_dump):
        try:
            return to_jsonable(model_dump(), depth + 1)
        except Exception:  # noqa: BLE001
            pass
    text = repr(value)
    return text if len(text) <= 200 else text[:200] + "…"


def preview_of(jsonable: Any) -> tuple[str, bool]:
    try:
        text = json.dumps(jsonable, default=str, ensure_ascii=False)
    except Exception:  # noqa: BLE001
        text = repr(jsonable)
    return (text, False) if len(text) <= _PREVIEW_MAX else (text[:_PREVIEW_MAX] + "…", True)


def preview(value: Any) -> tuple[str, bool]:
    return preview_of(to_jsonable(value))


def describe_args(args: dict[str, Any]) -> tuple[dict[str, str], bool, dict[str, Any]]:
    """-> (name -> preview string, any truncated?, name -> full jsonable)."""
    previews, full, any_trunc = {}, {}, False
    for name, value in args.items():
        if _SECRET_KEY_RE.search(name):
            previews[name], full[name] = "«redacted»", "«redacted»"
            continue
        j = to_jsonable(value)
        p, t = preview_of(j)
        previews[name], full[name], any_trunc = p, j, any_trunc or t
    return previews, any_trunc, full


# ── hub ─────────────────────────────────────────────────────────────────
class TraceHub:
    """Process-wide fan-out. ``publish`` is safe from any thread."""

    def __init__(self, tail: int = _TAIL_EVENTS) -> None:
        self._lock = threading.Lock()
        self._by_request: OrderedDict[str, list[dict]] = OrderedDict()
        self._tail_max = tail
        self._tail_n = 0
        self._subs: list[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = []
        self._recent: OrderedDict[str, "TraceCollector"] = OrderedDict()
        self.stats = {"published": 0, "dropped_slow_subscriber": 0}

    def subscribe(self, loop: asyncio.AbstractEventLoop) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        with self._lock:
            self._subs.append((loop, q))
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        with self._lock:
            self._subs = [(lo, qq) for lo, qq in self._subs if qq is not q]

    def publish(self, event: dict) -> None:
        with self._lock:
            self._by_request.setdefault(event["request_id"], []).append(event)
            self._tail_n += 1
            while self._tail_n > self._tail_max and len(self._by_request) > 1:
                _, dropped = self._by_request.popitem(last=False)
                self._tail_n -= len(dropped)
            self.stats["published"] += 1
            subs = list(self._subs)
        for loop, q in subs:
            if q.qsize() > _SUBSCRIBER_MAX_PENDING:
                self.stats["dropped_slow_subscriber"] += 1
                continue
            try:
                loop.call_soon_threadsafe(q.put_nowait, event)
            except RuntimeError:  # loop closed
                self.unsubscribe(q)

    def snapshot(self, n: int | None = None) -> list[dict]:
        with self._lock:
            items = [ev for evs in self._by_request.values() for ev in evs]
        return items if n is None else items[-n:]

    def clear(self) -> None:
        with self._lock:
            self._by_request.clear()
            self._tail_n = 0
            self._recent.clear()

    def register(self, collector: "TraceCollector") -> None:
        with self._lock:
            self._recent[collector.request_id] = collector
            self._recent.move_to_end(collector.request_id)
            while len(self._recent) > _RECENT_REQUESTS:
                self._recent.popitem(last=False)

    def collector(self, request_id: str) -> "TraceCollector | None":
        with self._lock:
            return self._recent.get(request_id)


_hub = TraceHub()


def hub() -> TraceHub:
    return _hub


# ── collector ───────────────────────────────────────────────────────────
_active: ContextVar["TraceCollector | None"] = ContextVar("_viz_active_trace", default=None)


def _ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


class TraceCollector:
    def __init__(self, request_id: str, max_spans: int | None = None, full_per_fn: int | None = None) -> None:
        self.request_id = request_id
        self.max_spans = CONFIG.max_spans_per_request if max_spans is None else max_spans
        self.full_per_fn = CONFIG.full_capture_per_fn if full_per_fn is None else full_per_fn
        self.span_count = 0
        self.fn_counts: dict[str, int] = {}
        self.route: str | None = None
        self.handler: str | None = None
        self._overflowed = False
        self._lock = threading.Lock()
        self._full: OrderedDict[tuple[str, str], Any] = OrderedDict()
        self._status: int | None = None

    def admit(self, label: str) -> tuple[bool, bool]:
        """At function entry -> (record this span?, serialize its args/result?)."""
        with self._lock:
            n = self.fn_counts.get(label, 0) + 1
            self.fn_counts[label] = n
            if self.span_count >= self.max_spans:
                first = not self._overflowed
                self._overflowed = True
            else:
                self.span_count += 1
                return True, n <= self.full_per_fn
        if first:
            self._emit("log", data={"level": "warn", "line": f"span limit reached ({self.max_spans}); "
                                                            "further calls are counted but not recorded"})
        return False, False

    def _remember(self, span_id: str, field: str, value: Any) -> None:
        with self._lock:
            self._full[(span_id, field)] = value
            self._full.move_to_end((span_id, field))
            while len(self._full) > _RING_PER_REQUEST:
                self._full.popitem(last=False)

    def full_value(self, span_id: str, field: str) -> Any:
        with self._lock:
            return self._full.get((span_id, field))

    def has_full(self, span_id: str, field: str) -> bool:
        with self._lock:
            return (span_id, field) in self._full

    def emit_call_start(self, *, span_id, parent_span_id, depth, label, qualname, module, file, line,
                        args: dict[str, Any] | None) -> None:
        captured = args is not None
        described, truncated = ({}, False)
        if captured:
            described, truncated, full = describe_args(args)
            self._remember(span_id, "args", full)
        self._emit("fn.start", span_id=span_id, parent_span_id=parent_span_id, depth=depth,
                   data={"name": label, "qualname": qualname, "module": module, "file": file, "line": line,
                         "args": described, "args_truncated": truncated, "captured": captured})

    def emit_call_end(self, *, span_id, parent_span_id, depth, label, duration_ms, retval, capture: bool) -> None:
        text, truncated = (None, False)
        if capture:
            full = to_jsonable(retval)
            self._remember(span_id, "result", full)
            text, truncated = preview_of(full)
        self._emit("fn.end", span_id=span_id, parent_span_id=parent_span_id, depth=depth,
                   data={"name": label, "duration_ms": duration_ms, "result": text,
                         "result_truncated": truncated, "captured": capture})

    def emit_call_error(self, *, span_id, parent_span_id, depth, label, duration_ms, exc_type, message,
                        traceback) -> None:
        self._emit("fn.error", span_id=span_id, parent_span_id=parent_span_id, depth=depth,
                   data={"name": label, "duration_ms": duration_ms, "exc_type": exc_type,
                         "message": message, "traceback": traceback[-4000:]})

    def finish(self, status: int) -> None:
        self._status = status

    def _emit(self, kind: str, *, span_id=None, parent_span_id=None, depth=0, data=None) -> None:
        _hub.publish({"kind": kind, "request_id": self.request_id, "span_id": span_id,
                      "parent_span_id": parent_span_id, "seq": next(_seq), "ts": time.time(),
                      "depth": depth, "data": data or {}})


@contextmanager
def trace_request(*, method: str, path: str, request_id: str | None = None) -> Iterator[TraceCollector]:
    collector = TraceCollector(request_id or ("req_" + secrets.token_hex(6)))
    _hub.register(collector)
    token = _active.set(collector)
    started = time.perf_counter()
    collector._emit("request.start", data={"method": method, "path": path})
    raised = False
    try:
        yield collector
    except BaseException:
        raised = True
        raise
    finally:
        status = collector._status if collector._status is not None else (500 if raised else 200)
        counts = sorted(collector.fn_counts.items(), key=lambda kv: -kv[1])[:200]
        collector._emit("request.end", data={"status": status, "duration_ms": _ms(started),
                                             "span_count": collector.span_count,
                                             "call_counts": dict(counts),
                                             "route": collector.route, "handler": collector.handler})
        _active.reset(token)


def build_requests(events: list[dict]) -> list[dict]:
    """Group a flat event list into requests with a span tree (REST/MCP consumers and tests)."""
    reqs: OrderedDict[str, dict] = OrderedDict()
    for ev in events:
        rid = ev["request_id"]
        req = reqs.setdefault(rid, {"request_id": rid, "method": None, "path": None, "route": None,
                                    "handler": None, "status": None, "duration_ms": None,
                                    "span_count": 0, "call_counts": {}, "_spans": OrderedDict()})
        d, k = ev["data"], ev["kind"]
        if k == "request.start":
            req.update(method=d.get("method"), path=d.get("path"), started=ev["ts"])
        elif k == "request.end":
            req.update(status=d.get("status"), duration_ms=d.get("duration_ms"), route=d.get("route"),
                       handler=d.get("handler"), span_count=d.get("span_count", 0),
                       call_counts=d.get("call_counts", {}))
        elif k == "fn.start":
            req["_spans"][ev["span_id"]] = {"span_id": ev["span_id"], "parent_span_id": ev["parent_span_id"],
                                            "depth": ev["depth"], "name": d["name"], "file": d.get("file"),
                                            "line": d.get("line"), "args": d.get("args"),
                                            "captured": d.get("captured"), "status": "running",
                                            "children": []}
        elif k in ("fn.end", "fn.error"):
            sp = req["_spans"].get(ev["span_id"])
            if sp:
                sp["duration_ms"] = d.get("duration_ms")
                if k == "fn.end":
                    sp.update(status="ok", result=d.get("result"))
                else:
                    sp.update(status="error", exc_type=d.get("exc_type"), message=d.get("message"))
    out = []
    for req in reqs.values():
        spans = req.pop("_spans")
        roots = []
        for sp in spans.values():
            parent = spans.get(sp["parent_span_id"]) if sp["parent_span_id"] else None
            (parent["children"] if parent else roots).append(sp)
        req["spans"] = roots
        out.append(req)
    return out

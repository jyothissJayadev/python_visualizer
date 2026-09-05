"""backend/tracer/monitor.py — the one place that touches sys.monitoring.

sys.monitoring (PEP 669, Python 3.12+) is process-global: one tool id, one
set of callbacks. We register PY_START / PY_RETURN / PY_UNWIND once, then
toggle them on only for the duration of a traced unit of work and route
every event to the single active TraceCollector.

Only one trace runs at a time. `trace_session()` takes an asyncio.Lock, so
a second request that wants tracing waits for the first to finish rather
than interleaving into its tree. For a single-developer inspection tool
(see the project README) that is the right trade: every traced request
gets a complete, correctly-nested tree.

Requires sys.monitoring. `is_supported()` lets callers degrade gracefully
on 3.11 and older (tracing simply unavailable) instead of crashing.
"""

from __future__ import annotations

import asyncio
import contextlib
import sys
from typing import Iterator

from backend.tracer.collector import TraceCollector

_TOOL_NAME = "python-backend-explorer"

_active: TraceCollector | None = None
_installed = False
_session_lock: asyncio.Lock | None = None


def is_supported() -> bool:
    return hasattr(sys, "monitoring") and hasattr(sys.monitoring, "PROFILER_ID")


def _events_mask():
    ev = sys.monitoring.events
    return ev.PY_START | ev.PY_RETURN | ev.PY_UNWIND


def _cb_start(code, instruction_offset):
    collector = _active
    if collector is None or not collector.should_trace(code):
        return
    try:
        collector.on_start(sys._getframe(1), code)
    except Exception:
        pass


def _cb_return(code, instruction_offset, retval):
    collector = _active
    if collector is None or not collector.should_trace(code):
        return
    try:
        collector.on_return(sys._getframe(1), retval)
    except Exception:
        pass


def _cb_unwind(code, instruction_offset, exc):
    collector = _active
    if collector is None or not collector.should_trace(code):
        return
    try:
        collector.on_unwind(sys._getframe(1), exc)
    except Exception:
        pass


def install() -> None:
    """Claim the sys.monitoring tool id and register callbacks. Idempotent.
    Events stay off until a trace_session() opens."""
    global _installed
    if _installed:
        return
    if not is_supported():
        raise RuntimeError("sys.monitoring is unavailable (needs Python 3.12+)")

    mon = sys.monitoring
    current = mon.get_tool(mon.PROFILER_ID)
    if current is None:
        mon.use_tool_id(mon.PROFILER_ID, _TOOL_NAME)
    elif current != _TOOL_NAME:
        raise RuntimeError(
            f"sys.monitoring profiler slot is already held by {current!r} "
            "(another profiler/coverage tool in the target?) — tracing unavailable"
        )
    mon.register_callback(mon.PROFILER_ID, mon.events.PY_START, _cb_start)
    mon.register_callback(mon.PROFILER_ID, mon.events.PY_RETURN, _cb_return)
    mon.register_callback(mon.PROFILER_ID, mon.events.PY_UNWIND, _cb_unwind)
    _installed = True


def uninstall() -> None:
    """Release the tool id — used by tests to keep the process clean."""
    global _installed, _active
    if not _installed:
        return
    mon = sys.monitoring
    mon.set_events(mon.PROFILER_ID, 0)
    for event in (mon.events.PY_START, mon.events.PY_RETURN, mon.events.PY_UNWIND):
        mon.register_callback(mon.PROFILER_ID, event, None)
    mon.free_tool_id(mon.PROFILER_ID)
    _installed = False
    _active = None


@contextlib.asynccontextmanager
async def trace_session(collector: TraceCollector):
    """Make `collector` the active trace for the duration of the block.
    Serialized against any other trace_session()."""
    global _active, _session_lock
    if _session_lock is None:
        _session_lock = asyncio.Lock()

    async with _session_lock:
        install()
        _active = collector
        mon = sys.monitoring
        mon.set_events(mon.PROFILER_ID, _events_mask())
        try:
            yield collector
        finally:
            mon.set_events(mon.PROFILER_ID, 0)
            _active = None


@contextlib.contextmanager
def trace_session_sync(collector: TraceCollector) -> Iterator[TraceCollector]:
    """Synchronous variant for non-async call sites and tests. No lock — the
    caller is responsible for not overlapping trace sessions."""
    global _active
    install()
    _active = collector
    mon = sys.monitoring
    mon.set_events(mon.PROFILER_ID, _events_mask())
    try:
        yield collector
    finally:
        mon.set_events(mon.PROFILER_ID, 0)
        _active = None

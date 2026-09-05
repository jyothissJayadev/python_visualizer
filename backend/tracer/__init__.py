"""backend/tracer/ — records the call tree (arguments in, value out, per
function) beneath a traced unit of work, using sys.monitoring.

Two entry points:
  * hosted.TracingMiddleware — wraps the target project's own ASGI app so
    every real HTTP request is traced (backend/app.py mounts it when
    --host-app is set).
  * function_runner.execute_function(trace=True) — traces one direct
    function execution.

Both write TraceRecords into a shared TraceStore, served by
backend/api/traces.py.
"""

from backend.tracer.collector import TraceCollector
from backend.tracer.models import TraceCall, TraceRecord, TraceSummary
from backend.tracer.monitor import is_supported, trace_session, trace_session_sync
from backend.tracer.store import TraceStore

__all__ = [
    "TraceCollector",
    "TraceCall",
    "TraceRecord",
    "TraceSummary",
    "TraceStore",
    "is_supported",
    "trace_session",
    "trace_session_sync",
]

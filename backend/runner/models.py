from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from backend.tracer.models import TraceRecord


class ExecuteRequest(BaseModel):
    arguments: dict[str, Any] = {}
    trace: bool = False
    """Record the nested call tree (arguments + return value of every
    function under the trace root) while this function runs, and return it
    as `trace`. Also stored in the traces ring buffer."""


class ExecutionResult(BaseModel):
    success: bool
    output: Any = None
    error_type: str | None = None
    error_message: str | None = None
    traceback: str | None = None
    duration_ms: float
    trace: TraceRecord | None = None
    trace_id: str | None = None

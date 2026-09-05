"""backend/api/traces.py — serves the recorded call trees.

Populated by backend/tracer: the hosted-app middleware (one record per HTTP
request through the target's own ASGI app) and direct executes run with
trace=True.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from backend.api.project import get_state
from backend.tracer.models import TraceRecord, TraceSummary

router = APIRouter()


@router.get("/api/traces", response_model=list[TraceSummary])
def list_traces(request: Request) -> list[TraceSummary]:
    return get_state(request).traces.summaries()


@router.get("/api/traces/{trace_id}", response_model=TraceRecord)
def get_trace(trace_id: str, request: Request) -> TraceRecord:
    record = get_state(request).traces.get(trace_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"no trace with id '{trace_id}' (ring buffer may have evicted it)")
    return record


@router.post("/api/traces/clear", status_code=204)
def clear_traces(request: Request) -> None:
    get_state(request).traces.clear()

"""backend/tracer/models.py — the shape of a recorded call tree.

A TraceRecord is one traced unit of work (one HTTP request through the
hosted app, or one direct function execution). Its `roots` are the
top-level calls that happened inside the target project's own code during
that window; each TraceCall nests its children the same way the real call
stack did — including across `await`, which sys.monitoring lets us follow
precisely (PY_START vs PY_RESUME are distinct events).
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class TraceCall(BaseModel):
    call_id: int
    """Monotonic per-record id, assigned in call order — lets the UI keep a
    stable key and show the sequence a function's children ran in."""
    qualname: str
    module: str
    file: str
    """Path relative to the target project root when the call is under it,
    absolute otherwise."""
    line: int
    args: dict[str, Any] = Field(default_factory=dict)
    """Argument name -> serialized value, captured at function entry. `self`
    and `cls` are summarized, not expanded."""
    return_value: Any = None
    returned: bool = False
    """True once PY_RETURN was seen. False + exception set means it unwound;
    False + no exception means the trace window closed before it finished
    (rare — e.g. a background task still running at response time)."""
    exception: str | None = None
    """"ExceptionType: message" if the call unwound with an exception."""
    duration_ms: float = 0.0
    depth: int
    children: list["TraceCall"] = Field(default_factory=list)
    children_truncated: bool = False
    """True if children past max_trace_depth / max_trace_calls were dropped."""


class TraceRecord(BaseModel):
    trace_id: str
    kind: str
    """"request" (HTTP call through the hosted app) or "function" (direct
    execute of one function)."""
    label: str
    """Human summary for the trace list, e.g. "POST /brain/quotation/x/commit"
    or "commit_quotation"."""
    method: str | None = None
    path: str | None = None
    status_code: int | None = None
    started_at: str
    duration_ms: float
    call_count: int
    truncated: bool
    """True if the global max_trace_calls cap was hit — the tree is partial."""
    error: str | None = None
    """Set if the whole traced unit failed (request raised, or direct
    execution errored before/around the call)."""
    roots: list[TraceCall] = Field(default_factory=list)


class TraceSummary(BaseModel):
    """What /api/traces returns for the list view — everything except the
    (potentially large) call tree."""

    trace_id: str
    kind: str
    label: str
    method: str | None = None
    path: str | None = None
    status_code: int | None = None
    started_at: str
    duration_ms: float
    call_count: int
    truncated: bool
    error: str | None = None

    @classmethod
    def of(cls, record: TraceRecord) -> "TraceSummary":
        return cls(**record.model_dump(exclude={"roots"}))

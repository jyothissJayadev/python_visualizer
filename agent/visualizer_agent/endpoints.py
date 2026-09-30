"""Unauthenticated dev endpoints the collector proxies to (same paths brain used)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from . import monitor, trace

router = APIRouter(tags=["visualizer-agent"])
@router.get("/__telemetry__/status")
def status(request: Request) -> dict[str, Any]:
    sink = getattr(request.app.state, "visualizer_sink", None)
    return {"enabled": True, "monitor": monitor.status(), "hub": trace.hub().stats,
            "sink": sink.stats() if hasattr(sink, "stats") else (sink or "not started")}


@router.post("/__telemetry__/instrument")
def instrument(payload: dict[str, Any]) -> dict[str, Any]:
    """Arm exactly ``payload["selections"]`` (``[{"id","deep"}]``); everything else is disarmed."""
    selections = payload.get("selections") or []
    if not isinstance(selections, list):
        raise HTTPException(status_code=400, detail="selections must be a list")
    return monitor.apply_selection(selections)


@router.get("/__telemetry__/value/{request_id}/{span_id}/{field}")
def value(request_id: str, span_id: str, field: str) -> dict[str, Any]:
    if field not in ("args", "result"):
        raise HTTPException(status_code=400, detail="field must be 'args' or 'result'")
    collector = trace.hub().collector(request_id)
    if collector is None:
        raise HTTPException(status_code=404, detail="request not in the recent ring buffer")
    if not collector.has_full(span_id, field):
        raise HTTPException(status_code=404, detail="value evicted or never recorded")
    return {"request_id": request_id, "span_id": span_id, "field": field,
            "value": collector.full_value(span_id, field)}

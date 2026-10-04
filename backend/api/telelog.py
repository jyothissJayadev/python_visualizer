"""backend/api/telelog.py — the telelog API behind the MCP tools and the edit hook.

  GET    /viewer/telelog/map                    everything the Telelog view draws (also when nothing is tagged)
  GET    /viewer/telelog/live?id=               declared fields of a tag with sample values from the newest trace
  GET    /viewer/telelog/flow?id=               the order an endpoint's code runs in, depth first (for the Run flow player)
  GET    /viewer/telelog/validate               every tag checked against the code
  GET    /viewer/telelog/untagged?limit&cursor&feature   a page of functions with no tag
  GET    /viewer/telelog/function?ids=a&ids=b   source, route, callers, callees, tables, existing tag
  GET    /viewer/telelog/features               existing features and their main functions
  GET    /viewer/telelog/parent?id=             candidate human parents from the call graph
  GET    /viewer/telelog/changed?paths=...      for the hook: changed tagged functions + untagged ones
  GET    /viewer/telelog/progress               audit progress
  POST   /viewer/telelog/progress {"ids": [...]}  record handled ids (tagged ones become verified)
  DELETE /viewer/telelog/progress               start a fresh audit

Every call first lets the service re-analyse if files changed (cheap fingerprint check), so an answer is
never older than the file on disk. Tags themselves are always read fresh from disk.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from backend.analysis import telelog_tools as tools
from backend.analysis.engine import Analysis
from backend.analysis.service import AnalysisService
from backend.analysis.telelog import read_tags, tagged_function_ids
from backend.analysis.telelog_live import live_values
from backend.analysis.telelog_store import TelelogConfig, TelelogStore, list_untagged, load_config

router = APIRouter(prefix="/viewer/telelog", tags=["telelog"])


@dataclass
class Ctx:
    analysis: Analysis
    store: TelelogStore
    config: TelelogConfig


async def _ctx(request: Request) -> Ctx:
    svc: AnalysisService = request.app.state.analysis_service
    try:
        await svc.refresh(reason="telelog")
    except Exception:  # noqa: BLE001 — keep serving the previous analysis
        pass
    if svc.analysis is None:
        raise HTTPException(503, "analysis not ready yet")
    root = Path(svc.project_path)
    return Ctx(svc.analysis, TelelogStore(root), load_config(root))


@router.get("/validate")
async def validate(request: Request) -> dict[str, Any]:
    c = await _ctx(request)
    return tools.validate(c.analysis, c.store, c.config.predicate())


@router.get("/untagged")
async def untagged(request: Request, limit: int = Query(15, ge=1, le=100), cursor: str | None = None,
                   feature: str | None = None) -> dict[str, Any]:
    c = await _ctx(request)
    return list_untagged(c.analysis, limit, cursor, feature, c.config.predicate())


@router.get("/function")
async def function(request: Request, ids: list[str] = Query(...)) -> list[dict[str, Any]]:
    c = await _ctx(request)
    return tools.get_function(c.analysis, ids[:25])


@router.get("/features")
async def features(request: Request) -> dict[str, Any]:
    c = await _ctx(request)
    return tools.feature_tree(read_tags(c.analysis))


@router.get("/parent")
async def parent(request: Request, id: str) -> list[dict[str, Any]]:
    c = await _ctx(request)
    if id not in c.analysis.registry.funcs:
        raise HTTPException(404, f"function not found: {id}")
    return tools.suggest_parent(c.analysis, id)


@router.get("/changed")
async def changed(request: Request, paths: list[str] = Query(...)) -> dict[str, Any]:
    c = await _ctx(request)
    return tools.check_changed(c.analysis, paths, c.store.verified(), c.config.predicate())


@router.get("/progress")
async def get_progress(request: Request) -> dict[str, Any]:
    return (await _ctx(request)).store.get_progress()


class ProgressBody(BaseModel):
    ids: list[str]


@router.post("/progress")
async def post_progress(request: Request, body: ProgressBody) -> dict[str, Any]:
    c = await _ctx(request)
    return tools.record_progress(c.analysis, c.store, body.ids)


@router.delete("/progress")
async def reset_progress(request: Request) -> dict[str, bool]:
    (await _ctx(request)).store.reset_progress()
    return {"ok": True}


@router.get("/map")
async def telelog_map(request: Request) -> dict[str, Any]:
    c = await _ctx(request)
    return tools.telelog_payload(c.analysis, read_tags(c.analysis), c.store.verified(), c.config.predicate())


@router.get("/live")
async def live(request: Request, id: str) -> dict[str, Any]:
    from backend.api import viewer  # the collector's in-memory trace ring buffer

    c = await _ctx(request)
    f = c.analysis.registry.funcs.get(id)
    if f is None:
        raise HTTPException(404, f"function not found: {id}")
    tag = tagged_function_ids(read_tags(c.analysis)).get(id)
    return live_values(list(viewer.HUB.recent), id, tag, f.params)


@router.get("/flow")
async def flow(request: Request, id: str) -> dict[str, Any]:
    c = await _ctx(request)
    out = tools.flow_steps(c.analysis, id)
    if out is None:
        raise HTTPException(404, f"function not found: {id}")
    return out

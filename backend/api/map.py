"""backend/api/map.py — the "Map" view API: the project's main functions,
entry points and algorithm cards, from the static analysis.

  GET  /viewer/map                     the whole map (mains, edges, modules, entry points)
  GET  /viewer/map/algorithm?id=       one function's algorithm card (locked skeleton + fill)
  PUT  /viewer/map/algorithm           store an LLM/agent fill (validated against the skeleton)
  GET  /viewer/map/overrides           pinned main/child choices
  PUT  /viewer/map/overrides           pin one function: {"id": ..., "role": "main"|"child"|null}
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend.analysis.algorithm import AlgorithmStore, card, skeleton
from backend.analysis.mapmodel import build_map
from backend.analysis.service import AnalysisService

router = APIRouter(prefix="/viewer/map", tags=["map"])


def _service(request: Request) -> AnalysisService:
    return request.app.state.analysis_service


def _dir(svc: AnalysisService) -> Path | None:
    base = svc._cache_dir
    return Path(base) / "map" if base is not None else None


def _overrides_file(svc: AnalysisService) -> Path | None:
    d = _dir(svc)
    return d / "overrides.json" if d else None


def _load_overrides(svc: AnalysisService) -> dict[str, str]:
    f = _overrides_file(svc)
    try:
        return json.loads(f.read_text(encoding="utf-8")) if f else {}
    except (OSError, ValueError):
        return {}


def _analysis(svc: AnalysisService):
    if svc.analysis is None:
        raise HTTPException(503, "analysis not ready yet")
    return svc.analysis


@router.get("")
async def get_map(request: Request) -> dict[str, Any]:
    svc = _service(request)
    return build_map(_analysis(svc), _load_overrides(svc))


@router.get("/algorithm")
async def get_algorithm(request: Request, id: str) -> dict[str, Any]:
    svc = _service(request)
    d = _dir(svc)
    store = AlgorithmStore(d / "algorithms") if d else None
    analysis = _analysis(svc)
    if store is None:
        skel = skeleton(analysis, id)
        out = card(skel, None, "filled") if skel else None
    else:
        out = store.card(analysis, id)
    if out is None:
        raise HTTPException(404, f"function not found: {id}")
    return out


class FillBody(BaseModel):
    fill: dict[str, Any]


@router.put("/algorithm")
async def put_algorithm(request: Request, body: FillBody) -> dict[str, Any]:
    svc = _service(request)
    d = _dir(svc)
    if d is None:
        raise HTTPException(409, "no cache directory configured")
    analysis = _analysis(svc)
    fid = body.fill.get("function_id")
    skel = skeleton(analysis, fid) if isinstance(fid, str) else None
    if skel is None:
        raise HTTPException(404, f"function not found: {fid}")
    problems = AlgorithmStore(d / "algorithms").put(skel, body.fill)
    if problems:
        raise HTTPException(422, {"problems": problems})
    return {"ok": True}


@router.get("/overrides")
async def get_overrides(request: Request) -> dict[str, str]:
    return _load_overrides(_service(request))


class OverrideBody(BaseModel):
    id: str
    role: str | None = None


@router.put("/overrides")
async def put_overrides(request: Request, body: OverrideBody) -> dict[str, str]:
    svc = _service(request)
    f = _overrides_file(svc)
    if f is None:
        raise HTTPException(409, "no cache directory configured")
    if body.role not in (None, "main", "child"):
        raise HTTPException(422, "role must be main, child or null")
    data = _load_overrides(svc)
    if body.role is None:
        data.pop(body.id, None)
    else:
        data[body.id] = body.role
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return data

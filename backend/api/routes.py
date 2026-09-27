"""backend/api/routes.py — the "Routes" view API: the target project's
endpoints and, for each, the hierarchy of functions it runs (handler ->
inner functions), from the static analysis in backend/analysis/.

  GET  /viewer/routes                 endpoint list, grouped by path prefix
  GET  /viewer/routes/endpoint?id=    one endpoint's full details
  GET  /viewer/routes/tree?id=&path=&depth=   lazy hierarchy (depth-limited)
  GET  /viewer/routes/data?id=        database tables the endpoint touches
  GET  /viewer/routes/database        every table brain touches, across all endpoints
  GET  /viewer/routes/function?id=    one function: signature, doc, source
  GET  /viewer/routes/status          analysis state (fingerprint, freshness)
  POST /viewer/routes/rescan          force a fresh analysis
  GET  /viewer/routes/runtime?id=     runtime overlay: what actually ran
  POST /viewer/routes/arm             arm / disarm an endpoint's handler (deep)

Endpoint ids contain "/" and braces ("POST /a/{x}"), so they travel as
query parameters, never path segments.
"""

from __future__ import annotations

import os
from collections import defaultdict
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from backend.analysis.callgraph import node_at, render
from backend.analysis.overlay import build_overlay, compute_extras
from backend.analysis.service import AnalysisService

router = APIRouter()

MAX_SOURCE_LINES = 400
MAX_TREE_DEPTH = 12
GROUP_SPLIT_THRESHOLD = 20


def get_service(request: Request) -> AnalysisService:
    return request.app.state.analysis_service


def _summary(e: dict[str, Any]) -> dict[str, Any]:
    doc = (e.get("docstring") or e.get("summary") or "").strip().split("\n")[0]
    return {
        "id": e["id"], "method": e["method"], "path": e["path"], "handler_id": e["handler_id"],
        "handler_name": e["handler_name"], "file_path": e["file_path"], "line": e["line"],
        "summary": doc[:200] or None, "tags": e["tags"], "is_async": e["is_async"],
        "conditional": e["conditional"], "factory": e["factory"], "param_app": e["param_app"],
    }


def _group_key(path: str, segments: int) -> str:
    parts = [p for p in path.split("/") if p and not p.startswith("{")]
    return "/" + "/".join(parts[:segments]) if parts else "/"


def group_endpoints(endpoints: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group by first path segment; split any group above the threshold by
    its first two segments so the sidebar stays scannable."""
    top: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for e in endpoints:
        top[_group_key(e["path"], 1)].append(e)
    grouped: dict[str, list[dict[str, Any]]] = {}
    for key, items in top.items():
        if len(items) > GROUP_SPLIT_THRESHOLD:
            for e in items:
                grouped.setdefault(_group_key(e["path"], 2), []).append(e)
        else:
            grouped[key] = items
    return [
        {"prefix": key, "count": len(items), "endpoints": [_summary(e) for e in items]}
        for key, items in sorted(grouped.items())
    ]


@router.get("/viewer/routes")
async def list_routes(request: Request):
    svc = get_service(request)
    if svc.analysis is not None:
        routes = svc.analysis.routes
        endpoints = [e.model_dump() for e in routes.endpoints]
        unmounted = [u.model_dump() for u in routes.unmounted]
        errors = routes.errors
    elif svc.cached_routes is not None:
        endpoints, unmounted, errors = svc.cached_routes["endpoints"], [], []
    else:
        endpoints, unmounted, errors = [], [], []
    from backend.api import viewer  # resolved at call time — tests swap viewer.HUB

    return JSONResponse({
        "analysis": svc.status_payload(),
        "brain_code": viewer.brain_code(),
        "groups": group_endpoints(endpoints),
        "unmounted": unmounted,
        "errors": errors,
    })


def _ready(svc: AnalysisService):
    if svc.analysis is None:
        raise HTTPException(status_code=503, detail="analysis not ready yet")
    return svc.analysis


@router.get("/viewer/routes/endpoint")
async def get_endpoint(request: Request, id: str):
    svc = get_service(request)
    _ready(svc)
    ep = svc.endpoint(id)
    if ep is None:
        raise HTTPException(status_code=404, detail=f"unknown endpoint: {id}")
    return JSONResponse(ep.model_dump())


@router.get("/viewer/routes/tree")
async def get_tree(request: Request, id: str, path: str = "0", depth: int = 3):
    """The hierarchy below node `path` ("0" = the handler), `depth` levels
    deep. Nodes cut by the depth limit carry `children_count`; fetch them by
    calling again with their `id` as `path`."""
    svc = get_service(request)
    _ready(svc)
    ep = svc.endpoint(id)
    if ep is None:
        raise HTTPException(status_code=404, detail=f"unknown endpoint: {id}")
    built = svc.tree_root(ep)
    if built is None:
        raise HTTPException(status_code=404, detail=f"handler {ep.handler_id} not found in the project")
    root, stats = built
    node = node_at(root, path)
    if node is None:
        raise HTTPException(status_code=404, detail=f"no node at path {path}")
    depth = max(0, min(depth, MAX_TREE_DEPTH))
    return JSONResponse({
        "endpoint_id": ep.id,
        "path": path,
        "generation": svc.generation,
        "stats": stats,
        "node": render(node, path, depth, detail_path=path),
    })


@router.get("/viewer/routes/data")
async def get_data(request: Request, id: str):
    """Every database table (Mongo collection / Beanie document / Neo4j label)
    the endpoint touches, derived from the code, with operations and the
    functions responsible (each with its path in the hierarchy)."""
    svc = get_service(request)
    _ready(svc)
    ep = svc.endpoint(id)
    if ep is None:
        raise HTTPException(status_code=404, detail=f"unknown endpoint: {id}")
    data = svc.data_for(ep)
    if data is None:
        raise HTTPException(status_code=404, detail=f"handler {ep.handler_id} not found in the project")
    return JSONResponse({"endpoint_id": ep.id, "generation": svc.generation, **data})


@router.get("/viewer/routes/database")
async def get_database(request: Request):
    """The project-wide table index (see analysis/dbindex.py): per table, the
    operations, the functions and endpoints that reach it (with real call
    chains), and its fields (from a model, or inferred from the code)."""
    svc = get_service(request)
    _ready(svc)
    return JSONResponse({"generation": svc.generation, **svc.database_index()})


@router.get("/viewer/routes/function")
async def get_function(request: Request, id: str):
    svc = get_service(request)
    analysis = _ready(svc)
    f = analysis.registry.funcs.get(id)
    if f is None:
        raise HTTPException(status_code=404, detail=f"unknown function: {id}")
    source: str | None = None
    truncated = False
    full = os.path.abspath(os.path.join(svc.project_path, f.file_path))
    if full.startswith(svc.project_path + os.sep):
        try:
            with open(full, "r", encoding="utf-8") as fh:
                lines = fh.read().splitlines()
            chunk = lines[f.line - 1 : f.end_line]
            truncated = len(chunk) > MAX_SOURCE_LINES
            source = "\n".join(chunk[:MAX_SOURCE_LINES])
        except OSError:
            pass
    import ast

    return JSONResponse({
        "id": f.id, "name": f.name, "qual": f.qual, "module": f.module, "file_path": f.file_path,
        "line": f.line, "end_line": f.end_line, "signature": f.signature, "is_async": f.is_async,
        "decorators": f.decorators, "class_id": f.class_id, "docstring": ast.get_docstring(f.node),
        "source": source, "source_truncated": truncated,
    })


@router.get("/viewer/routes/status")
async def routes_status(request: Request):
    from backend.api import viewer  # resolved at call time — tests swap viewer.HUB

    svc = get_service(request)
    return JSONResponse({
        **svc.status_payload(),
        "current_fingerprint": svc.compute_fingerprint(),
        "stale": svc.fingerprint is not None and svc.compute_fingerprint() != svc.fingerprint,
        "brain_fingerprint": viewer.HUB.brain_fingerprint,
        "code_in_sync": viewer._code_in_sync(),
    })


@router.post("/viewer/routes/rescan")
async def rescan_routes(request: Request):
    svc = get_service(request)
    changed = await svc.refresh(force=True, reason="manual rescan")
    return JSONResponse({"changed": changed, **svc.status_payload()})


@router.get("/viewer/routes/runtime")
async def get_runtime(request: Request, id: str):
    """Runtime overlay for one endpoint, from the collector's recent trace
    events: per-function call counts / timings / errors / last I/O, the
    static edges that were observed, callees the static tree missed, and
    which functions are armed (only armed functions emit spans)."""
    from backend.api import viewer  # resolved at call time — tests swap viewer.HUB

    svc = get_service(request)
    _ready(svc)
    ep = svc.endpoint(id)
    if ep is None:
        raise HTTPException(status_code=404, detail=f"unknown endpoint: {id}")
    built = svc.tree_root(ep)
    overlay = build_overlay(list(viewer.HUB.recent), ep.id, svc.matcher(), viewer.HUB.selection)
    children = overlay.pop("_children")
    overlay["extras"] = compute_extras(built[0], children) if built else {}
    overlay["brain_connected"] = viewer.HUB.brain_base_url is not None
    overlay["generation"] = svc.generation
    return JSONResponse(overlay)


class ArmRequest(BaseModel):
    id: str
    armed: bool = True
    deep: bool = True


@router.post("/viewer/routes/arm")
async def arm_endpoint(request: Request, body: ArmRequest):
    """Arm (or disarm) this endpoint's handler. Deep arming makes brain record
    every nested call under app/ while the handler runs, so one selection
    lights up the whole hierarchy. The rest of the current selection is kept."""
    from backend.api import viewer

    svc = get_service(request)
    _ready(svc)
    ep = svc.endpoint(body.id)
    if ep is None:
        raise HTTPException(status_code=404, detail=f"unknown endpoint: {body.id}")
    selection = {s["id"]: s for s in viewer.HUB.selection if s.get("id")}
    if body.armed:
        selection[ep.handler_id] = {"id": ep.handler_id, "deep": body.deep}
    else:
        selection.pop(ep.handler_id, None)
    viewer.HUB.selection = list(selection.values())
    if not viewer.HUB.brain_base_url:
        return JSONResponse({
            "ok": False, "armed": [], "unresolved": [],
            "error": "brain is not connected — start it with telemetry enabled (see README); "
                     "the selection is remembered and applied when it registers",
        })
    result = await viewer._push_selection(viewer.HUB.selection)
    await viewer.HUB.broadcast({"kind": "selection_applied", **result})
    return JSONResponse({"ok": not result.get("error"), **result})

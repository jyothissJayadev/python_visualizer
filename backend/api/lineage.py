"""backend/api/lineage.py — End-to-End full stack cross-layer lineage API.

Exposes endpoints for exploring the cross-service call chains:
  GET  /viewer/lineage             Full lineage chains and summary statistics
  GET  /viewer/lineage/chain?id=   Single chain detail by Brain endpoint ID
  POST /viewer/lineage/rescan      Force a fresh AST scan across all apps
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from backend.analysis.lineage import LineageService

router = APIRouter(prefix="/viewer/lineage", tags=["lineage"])


def get_lineage_service(request: Request) -> LineageService:
    service = getattr(request.app.state, "lineage_service", None)
    if service is None:
        project_path = request.app.state.explorer_state.config.project_path
        service = LineageService(project_path)
        request.app.state.lineage_service = service
    return service


@router.get("")
async def get_lineage(request: Request, force: bool = False) -> dict[str, Any]:
    """Returns the full cross-stack lineage graph and summary stats."""
    service = get_lineage_service(request)
    return await service.get_lineage(force=force)


@router.get("/chain")
async def get_chain(request: Request, id: str = Query(..., description="Brain endpoint ID, e.g. 'POST /execution/extraction/predict'")) -> dict[str, Any]:
    """Returns the single lineage chain matching the given Brain endpoint ID."""
    service = get_lineage_service(request)
    data = await service.get_lineage()
    chains = data.get("chains", [])
    for chain in chains:
        if chain.get("id") == id or chain.get("path") == id:
            return {"chain": chain}
    raise HTTPException(status_code=404, detail=f"Lineage chain not found for endpoint: {id}")


@router.post("/rescan")
async def rescan_lineage(request: Request) -> dict[str, Any]:
    """Forces an immediate rescan of Brain, Backend, Frontend, and Admin codebases."""
    service = get_lineage_service(request)
    return await service.rescan()

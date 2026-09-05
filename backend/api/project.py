from __future__ import annotations

from fastapi import APIRouter, Request

from backend.scanner.models import ScanResult
from backend.state import ExplorerState

router = APIRouter()


def get_state(request: Request) -> ExplorerState:
    return request.app.state.explorer_state


@router.get("/api/project", response_model=ScanResult)
def get_project(request: Request) -> ScanResult:
    return get_state(request).scan_result


@router.post("/api/project/rescan", response_model=ScanResult)
def rescan_project(request: Request) -> ScanResult:
    return get_state(request).rescan()

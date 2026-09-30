"""backend/api/instance.py — which instance is this? The dashboard reads it to set its title
and to hide tabs the instance doesn't offer."""

from __future__ import annotations

from fastapi import APIRouter, Request

router = APIRouter()


@router.get("/viewer/instance")
async def get_instance(request: Request):
    config = request.app.state.config
    return {
        "name": config.name,
        "project": config.project_path,
        "features": list(config.features),
        "port": config.port,
    }

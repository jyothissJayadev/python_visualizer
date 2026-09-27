from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from backend.analysis.lineage import LineageService
from backend.analysis.service import CACHE_DIR, AnalysisService
from backend.api import viewer
from backend.api.lineage import router as lineage_router
from backend.api.routes import router as routes_router
from backend.api.viewer import router as viewer_router
from backend.config import DEFAULT_IGNORED_DIRECTORIES, ExplorerConfig
from backend.state import ExplorerState

# Vite's dev server picks the next free port when 5173 is taken, so match
# any localhost/127.0.0.1 port rather than hardcoding one. Loopback-only
# scope makes this safe — there is no other possible caller.
_DEV_FRONTEND_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1):\d+$"


def create_app(
    config: ExplorerConfig, *, watch: bool = True, cache_dir=CACHE_DIR, analyze_on_start: bool = True
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.explorer_state = ExplorerState(config)
        viewer.HUB.project_path = config.project_path
        # viewer.HUB is looked up per call: tests replace it
        service = AnalysisService(
            config,
            broadcast=lambda msg: viewer.HUB.broadcast(msg),
            cache_dir=cache_dir,
            # the terminal's function catalogue (Add / Manage Functions, MCP list_functions) is a
            # separate scan; keep it in step with the analysis instead of waiting for a manual rescan
            on_analyzed=app.state.explorer_state.rescan,
        )
        app.state.analysis_service = service
        lineage = LineageService(
            config.project_path,
            cache_file=(Path(cache_dir) / "lineage_cache.json") if cache_dir is not None else None,
        )
        app.state.lineage_service = lineage
        if analyze_on_start:
            await service.start(watch=watch)
            if watch:  # the lineage scanner runs `node` and reads the sibling apps: only with the file watcher
                await lineage.start(broadcast=lambda msg: viewer.HUB.broadcast(msg))
        try:
            yield
        finally:
            await lineage.stop()
            await service.stop()

    app = FastAPI(title="Brain Terminal", lifespan=lifespan)
    # tree payloads are repetitive JSON (~10x smaller compressed)
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=_DEV_FRONTEND_ORIGIN_REGEX,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(viewer_router)
    app.include_router(routes_router)
    app.include_router(lineage_router)
    return app


def make_app() -> FastAPI:
    """Factory for ``uvicorn backend.app:make_app --factory --reload`` — the
    reloader needs an import string, not a built app object. Config is read
    from the env vars ``backend.main`` sets before handing off to uvicorn."""
    extra = [d for d in os.environ.get("BRAIN_TERMINAL_IGNORE", "").split(os.pathsep) if d]
    config = ExplorerConfig(
        project_path=os.path.abspath(os.environ["BRAIN_TERMINAL_PROJECT"]),
        host=os.environ.get("BRAIN_TERMINAL_HOST", "127.0.0.1"),
        port=int(os.environ.get("BRAIN_TERMINAL_PORT", "8765")),
        ignored_directories=frozenset(DEFAULT_IGNORED_DIRECTORIES | set(extra)),
    )
    return create_app(config)

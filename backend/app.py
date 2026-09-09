from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api.viewer import router as viewer_router
from backend.config import ExplorerConfig
from backend.state import ExplorerState

# Vite's dev server picks the next free port when 5173 is taken, so match
# any localhost/127.0.0.1 port rather than hardcoding one. Loopback-only
# scope makes this safe — there is no other possible caller.
_DEV_FRONTEND_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1):\d+$"


def create_app(config: ExplorerConfig) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.explorer_state = ExplorerState(config)
        yield

    app = FastAPI(title="Brain Terminal", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=_DEV_FRONTEND_ORIGIN_REGEX,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(viewer_router)
    return app

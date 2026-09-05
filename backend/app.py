from __future__ import annotations

from contextlib import AsyncExitStack, asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api.functions import router as functions_router
from backend.api.project import router as project_router
from backend.api.traces import router as traces_router
from backend.api.viewer import router as viewer_router
from backend.config import ExplorerConfig
from backend.runner.function_runner import prepare_import_environment
from backend.state import ExplorerState
from backend.tracer.hosted import TracingMiddleware, load_hosted_app
from backend.tracer.store import TraceStore

# Vite's dev server picks the next free port when 5173 is taken, so match
# any localhost/127.0.0.1 port rather than hardcoding one. Loopback-only
# scope makes this safe — there is no other possible caller (§3).
_DEV_FRONTEND_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1):\d+$"


def create_app(config: ExplorerConfig) -> FastAPI:
    traces = TraceStore(capacity=config.max_traces)

    hosted_app = None
    if config.host_app:
        # The hosted app's module has to be importable before we can mount
        # it, so set up sys.path / cwd now rather than waiting for lifespan.
        prepare_import_environment(config)
        hosted_app = load_hosted_app(config.host_app)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        prepare_import_environment(config)
        app.state.explorer_state = ExplorerState(config, traces=traces)
        async with AsyncExitStack() as stack:
            if hosted_app is not None:
                # Mounted sub-apps don't get their lifespan run automatically
                # — drive brain's (which calls init_context_grabber_db) here.
                await stack.enter_async_context(hosted_app.router.lifespan_context(hosted_app))
            yield

    app = FastAPI(title="Python Backend Explorer", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=_DEV_FRONTEND_ORIGIN_REGEX,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(project_router)
    app.include_router(functions_router)
    app.include_router(traces_router)
    app.include_router(viewer_router)

    if hosted_app is not None:
        # "" or "/" => drop-in mode: brain answers on its own paths (no
        # prefix), so callers that already talk to brain need only change
        # the port. The explorer's own /api/* routes are registered above
        # and take precedence over the mount.
        mount_at = "" if config.host_app_mount in ("", "/") else config.host_app_mount
        app.mount(mount_at, TracingMiddleware(hosted_app, config=config, store=traces))

    return app

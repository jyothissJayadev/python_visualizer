"""visualizer_agent -- target-side half of the Brain Terminal visualizer.

    from visualizer_agent import install
    install(app, project_root=Path(__file__).resolve().parents[1])   # no-op unless enabled

Enabled by ``VISUALIZER_ENABLED=1`` (or the legacy ``BRAIN_TELEMETRY_ENABLED=1``); the collector
address comes from ``VISUALIZER_SINK_URL`` and the target's own base URL from
``VISUALIZER_SELF_URL``. Nothing is instrumented until the dashboard sends a selection, and
nothing is imported or registered when the agent is disabled.

The ``/__telemetry__/*`` endpoints are unauthenticated and can arm tracing of any function in
the process: never enable this in production.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Callable

import httpx
from fastapi import FastAPI

from . import endpoints, monitor, trace
from .settings import AgentSettings, resolve
from .sink import Sink
from .trace import register_summarizer

__all__ = ["install", "register_summarizer"]

logger = logging.getLogger("uvicorn.error")
_SKIP_PREFIX = "/__telemetry__"


class TraceMiddleware:
    """Pure ASGI: one trace context per HTTP request, and lazy start of the background sink."""

    def __init__(self, app, settings: AgentSettings, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.app = app
        self._settings = settings
        self._transport = transport

    def _ensure_sink(self, scope) -> None:
        """Start the background sink on the first request (it needs the running event loop).
        It lives on ``app.state`` so it belongs to this app, not to the process."""
        state = scope["app"].state
        if getattr(state, "visualizer_sink", None) is not None:
            return
        s = self._settings
        if not s.sink_url:
            state.visualizer_sink = "disabled"
            logger.warning("visualizer agent: no sink URL (set VISUALIZER_SINK_URL) -- events are not forwarded")
            return
        sink = Sink(sink_url=s.sink_url, self_url=s.self_url, project_root=s.project_root,
                    package_root=s.package_root, register_interval_s=s.register_interval_s,
                    transport=self._transport)
        state.visualizer_sink = sink
        sink.start()

    async def __call__(self, scope, receive, send) -> None:
        if (scope["type"] != "http" or scope.get("path", "").startswith(_SKIP_PREFIX)
                or b"__trace=0" in scope.get("query_string", b"")):
            await self.app(scope, receive, send)
            return
        self._ensure_sink(scope)
        status = {"code": 500}

        async def _send(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
            await send(message)

        with trace.trace_request(method=scope.get("method", "GET"), path=scope.get("path", "")) as collector:
            try:
                await self.app(scope, receive, _send)
            finally:
                collector.finish(status["code"])
                collector.route = getattr(scope.get("route"), "path", None)
                collector.handler = getattr(scope.get("endpoint"), "__name__", None)
                monitor.on_request_end(collector)


def install(app: FastAPI, *, project_root: str | Path, package_root: str | Path | None = None,
            sink_url: str | None = None, self_url: str | None = None, enabled: bool | None = None,
            max_spans_per_request: int | None = None, full_capture_per_fn: int | None = None,
            summarizers: dict[str | type, Callable] | None = None,
            sink_transport: httpx.AsyncBaseTransport | None = None) -> bool:
    """Attach the agent to ``app``. Returns True if it is active, False if disabled."""
    settings = resolve(project_root=project_root, package_root=package_root, sink_url=sink_url,
                       self_url=self_url, enabled=enabled, max_spans=max_spans_per_request,
                       full_capture_per_fn=full_capture_per_fn)
    if not settings.enabled:
        return False
    trace.CONFIG.max_spans_per_request = settings.max_spans_per_request
    trace.CONFIG.full_capture_per_fn = settings.full_capture_per_fn
    for key, fn in (summarizers or {}).items():
        register_summarizer(key, fn)
    monitor.configure(package_root=settings.package_root, project_root=settings.project_root)
    ok = monitor.install()
    app.add_middleware(TraceMiddleware, settings=settings, transport=sink_transport)
    app.include_router(endpoints.router)
    logger.info("visualizer agent: sys.monitoring=%s, sink=%s -- waiting for a selection from the dashboard",
                "ready" if ok else "UNAVAILABLE", settings.sink_url or "(none)")
    return True

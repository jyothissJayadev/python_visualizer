"""backend/tracer/hosted.py — imports the target project's own ASGI app and
wraps it so every request through it is traced.

This is the "connect to the real server" path: instead of the explorer
calling one function, it hosts brain's actual FastAPI app in-process
(mounted under a prefix) and records the full call tree — arguments and
return values of every function under the trace root — for each request.
"""

from __future__ import annotations

import importlib
import time
import uuid
from datetime import datetime, timezone

from backend.config import ExplorerConfig
from backend.tracer.collector import TraceCollector
from backend.tracer.monitor import is_supported, trace_session
from backend.tracer.store import TraceStore


class HostedAppError(RuntimeError):
    """The configured --host-app couldn't be imported / resolved."""


def load_hosted_app(spec: str):
    """Resolve "module.path:attr" to the ASGI application object.

    Import happens here, in the explorer process, after
    prepare_import_environment() and any --startup-hook have run — the
    hosted app's own import-time and lifespan setup then behaves exactly as
    it would running the target directly.
    """
    module_path, sep, attr = spec.partition(":")
    if not sep or not module_path or not attr:
        raise HostedAppError(f"--host-app must be 'module.path:attr', got {spec!r}")
    try:
        module = importlib.import_module(module_path)
    except Exception as exc:  # noqa: BLE001 - surface the real cause to the CLI
        raise HostedAppError(f"could not import '{module_path}': {type(exc).__name__}: {exc}") from exc
    try:
        return getattr(module, attr)
    except AttributeError as exc:
        raise HostedAppError(f"module '{module_path}' has no attribute '{attr}'") from exc


class TracingMiddleware:
    """Pure-ASGI wrapper around the hosted app. Pure ASGI (not
    BaseHTTPMiddleware) so the traced code runs in the same task/context the
    request arrives on — no extra task hop between here and the endpoint.
    """

    def __init__(self, app, *, config: ExplorerConfig, store: TraceStore) -> None:
        self.app = app
        self.config = config
        self.store = store
        self._trace_root = config.resolved_trace_root()
        self._key_header = config.internal_api_key_header.lower().encode("latin-1")
        self._key_value = (
            config.internal_api_key.encode("latin-1") if config.internal_api_key else None
        )
        self._tracing_broken = False

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        scope = self._with_injected_key(scope)
        query = scope.get("query_string", b"").decode("latin-1", "replace")
        if "__trace=0" in query or not is_supported():
            await self.app(scope, receive, send)
            return

        if self._tracing_broken:
            await self.app(scope, receive, send)
            return

        collector = TraceCollector(
            trace_root=self._trace_root,
            project_path=self.config.project_path,
            max_calls=self.config.max_trace_calls,
            max_depth=self.config.max_trace_depth,
            value_max_depth=self.config.trace_value_max_depth,
            max_items=self.config.max_collection_items,
            max_string_length=self.config.trace_value_max_string_length,
        )

        state = {"status": None}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                state["status"] = message["status"]
            await send(message)

        method = scope.get("method", "GET")
        # Starlette's Mount leaves scope["path"] as the full request path and
        # offsets matching via root_path, so this is already mount-prefixed.
        display_path = scope.get("path", "")

        started_at = datetime.now(timezone.utc).isoformat()
        start = time.perf_counter()
        error: str | None = None

        try:
            session = trace_session(collector)
            await session.__aenter__()
        except RuntimeError:
            # sys.monitoring slot unavailable — run untraced from now on.
            self._tracing_broken = True
            await self.app(scope, receive, send)
            return

        try:
            try:
                await self.app(scope, receive, send_wrapper)
            except Exception as exc:  # noqa: BLE001 - record, then re-raise
                error = f"{type(exc).__name__}: {exc}"
                raise
        finally:
            await session.__aexit__(None, None, None)
            duration_ms = (time.perf_counter() - start) * 1000
            record = collector.build_record(
                trace_id=uuid.uuid4().hex[:12],
                kind="request",
                label=f"{method} {display_path}",
                started_at=started_at,
                duration_ms=duration_ms,
                method=method,
                path=display_path,
                status_code=state["status"],
                error=error,
            )
            self.store.add(record)

    def _with_injected_key(self, scope):
        if self._key_value is None:
            return scope
        headers = [
            (name, value)
            for (name, value) in scope.get("headers", [])
            if name.lower() != self._key_header
        ]
        headers.append((self._key_header, self._key_value))
        new_scope = dict(scope)
        new_scope["headers"] = headers
        return new_scope

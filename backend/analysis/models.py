"""backend/analysis/models.py — output models of the route/call-graph
analysis. Pydantic so the API layer can return them directly as JSON.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class Endpoint(BaseModel):
    id: str
    """Unique + stable: "METHOD /full/path" (suffixed "#n" on collision)."""
    method: str
    """GET/POST/PUT/PATCH/DELETE/... or WS for websocket routes."""
    path: str
    """Full path after resolving every include_router prefix."""
    handler_id: str
    """"dotted.module:QualName" — the same id brain's monitor resolves. Nested
    handlers use the Python qualname, e.g. "mod:factory.<locals>._get"."""
    handler_name: str
    file_path: str
    line: int
    signature: str
    is_async: bool
    docstring: str | None = None
    summary: str | None = None
    response_model: str | None = None
    status_code: str | None = None
    tags: list[str] = Field(default_factory=list)
    dependencies: list[str] = Field(default_factory=list)
    """Router-level + route-level + handler-parameter Depends(...) targets."""
    dependency_ids: list[str] = Field(default_factory=list)
    """Router-level + route-level Depends(...) targets resolved to function
    ids (handler-parameter Depends are found by the call-graph builder)."""
    mount_chain: list[str] = Field(default_factory=list)
    """Router ids from the app down to the router that owns the route."""
    factory: str | None = None
    """"module:function" of the router factory that built this router."""
    bindings: dict[str, str | None] = Field(default_factory=dict)
    """Factory keyword arguments that are project functions, resolved to
    function ids (e.g. get_session -> "app.quotation...:get_session")."""
    conditional: bool = False
    """The route is registered under an `if` we could not evaluate."""
    param_app: bool = False
    """Mounted on an `app` function parameter (e.g. telemetry.setup(app)) —
    assumed to be the root app."""


class UnmountedRouter(BaseModel):
    id: str
    file_path: str
    line: int
    route_count: int


class RouteAnalysis(BaseModel):
    project_path: str
    module_count: int
    endpoints: list[Endpoint]
    unmounted: list[UnmountedRouter]
    errors: list[str] = Field(default_factory=list)

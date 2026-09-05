"""backend/config.py — explorer runtime configuration.

Everything the CLI accepts lives on this one dataclass. Kept intentionally
small (§7 of the spec): no YAML, no profiles — just the knobs needed to
point the explorer at a project and control how it imports/executes code.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

DEFAULT_IGNORED_DIRECTORIES: frozenset[str] = frozenset(
    {
        ".git",
        ".venv",
        "venv",
        "env",
        "__pycache__",
        "node_modules",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
    }
)


@dataclass(frozen=True)
class ExplorerConfig:
    project_path: str
    host: str = "127.0.0.1"
    port: int = 8765
    ignored_directories: frozenset[str] = field(default_factory=lambda: DEFAULT_IGNORED_DIRECTORIES)
    working_directory: str | None = None
    """Directory the runner chdir's into before importing/executing. Defaults
    to project_path. Matters for target projects (like brain) whose own
    startup code calls load_dotenv() with no args, which searches cwd."""
    startup_hook: str | None = None
    """Optional "module.path:function_name" run once (awaited if async)
    before the first function execution — for projects whose real entrypoint
    does setup (e.g. registering ODM document models) outside any single
    function the explorer would otherwise call directly."""
    max_output_depth: int = 6
    max_collection_items: int = 200
    max_string_length: int = 5000

    host_app: str | None = None
    """Optional "module.path:attr" of an ASGI app (e.g. brain's
    "app.main:app") to import and mount under /<host_app_mount>. When set,
    every request through it is traced: the call tree of the target
    project's own functions, with arguments and return values."""
    host_app_mount: str = "/app"
    """URL prefix the hosted ASGI app is mounted at."""
    internal_api_key: str | None = None
    """Value to inject as `internal_api_key_header` on every proxied request
    to the hosted app, so callers don't need the target's shared secret
    (brain rejects un-keyed /quotation and /execution calls). None = inject
    nothing."""
    internal_api_key_header: str = "x-internal-api-key"
    trace_root: str | None = None
    """Only calls in files under this directory are recorded. Defaults to
    "<project>/app" when that exists, else the project root — keeps the tree
    to the target's own code, not its venv or the stdlib."""
    max_traces: int = 50
    """Ring-buffer size for recorded traces."""
    max_trace_calls: int = 20000
    """Hard cap on recorded calls per trace; the tree is marked truncated
    past this."""
    max_trace_depth: int = 60
    trace_value_max_depth: int = 4
    """Serialization depth for captured argument / return values (shallower
    than max_output_depth — a trace has many values, each wants to stay
    small)."""
    trace_value_max_string_length: int = 2000

    def resolved_working_directory(self) -> str:
        return self.working_directory or self.project_path

    def resolved_trace_root(self) -> str:
        if self.trace_root:
            return os.path.abspath(self.trace_root)
        app_dir = os.path.join(self.project_path, "app")
        if os.path.isdir(app_dir):
            return app_dir
        return self.project_path

    def should_ignore_dir(self, dir_name: str) -> bool:
        if dir_name.startswith("."):
            return True
        return dir_name in self.ignored_directories

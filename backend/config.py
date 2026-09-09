"""backend/config.py — explorer runtime configuration.

Everything the CLI accepts lives on this one dataclass. Kept intentionally
small: no YAML, no profiles — just the knobs needed to point the explorer
at a project and control how its source is scanned.
"""

from __future__ import annotations

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

    def should_ignore_dir(self, dir_name: str) -> bool:
        if dir_name.startswith("."):
            return True
        return dir_name in self.ignored_directories

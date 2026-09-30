"""Agent configuration. Explicit ``install(...)`` arguments win, then ``VISUALIZER_*`` env vars,
then the legacy ``BRAIN_TELEMETRY_*`` names (so an existing brain setup keeps working)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

_TRUE = {"1", "true", "yes", "on"}


def _env(*names: str) -> str | None:
    for n in names:
        v = os.environ.get(n)
        if v is not None and v.strip():
            return v.strip()
    return None


def _clean_url(url: str | None) -> str:
    """Strip whitespace and a trailing slash; a value like ``http://x  # note`` (cmd.exe
    ``set`` keeps the comment) is cut at the first whitespace."""
    return (url or "").split()[0].rstrip("/") if url and url.split() else ""


@dataclass(frozen=True)
class AgentSettings:
    enabled: bool
    sink_url: str
    self_url: str
    project_root: Path
    package_root: Path
    max_spans_per_request: int = 5000
    full_capture_per_fn: int = 50
    register_interval_s: float = 30.0


def resolve(*, project_root: str | Path, package_root: str | Path | None = None, sink_url: str | None = None,
            self_url: str | None = None, enabled: bool | None = None, max_spans: int | None = None,
            full_capture_per_fn: int | None = None) -> AgentSettings:
    root = Path(project_root).resolve()
    if package_root is None:
        package_root = root / "app" if (root / "app").is_dir() else root
    if enabled is None:
        enabled = (_env("VISUALIZER_ENABLED", "BRAIN_TELEMETRY_ENABLED") or "").lower() in _TRUE
    return AgentSettings(
        enabled=enabled,
        # No default sink: with several visualizer instances there is no "default" collector, and
        # silently reporting to the wrong one is worse than reporting to none.
        sink_url=_clean_url(sink_url or _env("VISUALIZER_SINK_URL", "BRAIN_TELEMETRY_SINK_URL")),
        self_url=_clean_url(self_url or _env("VISUALIZER_SELF_URL", "BRAIN_TELEMETRY_SELF_URL")),
        project_root=root,
        package_root=Path(package_root).resolve(),
        max_spans_per_request=max_spans or int(_env("VISUALIZER_MAX_SPANS") or 5000),
        full_capture_per_fn=full_capture_per_fn or int(_env("VISUALIZER_FULL_CAPTURE_PER_FN") or 50),
    )

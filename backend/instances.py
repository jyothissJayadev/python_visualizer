"""backend/instances.py — named visualizer instances.

One visualizer install can watch several target backends at once. Each *instance* is a
(target project, backend port, frontend port, feature set) tuple; ``instances.json`` at the
repo root lists them and ``python -m backend.dev --instance NAME`` (or ``--all``) launches them.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from pathlib import Path

ALL_FEATURES: tuple[str, ...] = ("terminal", "routes", "database", "lineage")
DEFAULT_INSTANCES_FILE = Path(__file__).resolve().parent.parent / "instances.json"


class InstanceError(ValueError):
    pass


@dataclass(frozen=True)
class Instance:
    name: str
    project: str
    backend_port: int
    frontend_port: int
    target_url: str = ""
    features: tuple[str, ...] = ALL_FEATURES
    ignore: tuple[str, ...] = field(default_factory=tuple)

    @property
    def sink_url(self) -> str:
        """Where the target's agent should send telemetry (this instance's backend)."""
        return f"http://127.0.0.1:{self.backend_port}"

    def env_for_target(self) -> dict[str, str]:
        """The environment a target needs to report to this instance."""
        return {
            "VISUALIZER_ENABLED": "1",
            "VISUALIZER_SINK_URL": self.sink_url,
            "VISUALIZER_SELF_URL": self.target_url,
        }


def project_key(project_path: str) -> str:
    """Stable short key for per-project cache files (shared by every cache)."""
    return hashlib.sha1(os.path.abspath(project_path).encode()).hexdigest()[:12]


def _parse(raw: dict, index: int) -> Instance:
    for key in ("name", "project", "backend_port", "frontend_port"):
        if key not in raw:
            raise InstanceError(f"instance #{index}: missing '{key}'")
    features = tuple(raw.get("features", ALL_FEATURES))
    unknown = [f for f in features if f not in ALL_FEATURES]
    if unknown:
        raise InstanceError(f"instance '{raw['name']}': unknown feature(s) {unknown}; valid: {list(ALL_FEATURES)}")
    if "terminal" not in features:
        raise InstanceError(f"instance '{raw['name']}': 'terminal' is required")
    return Instance(
        name=str(raw["name"]),
        project=os.path.abspath(str(raw["project"])),
        backend_port=int(raw["backend_port"]),
        frontend_port=int(raw["frontend_port"]),
        target_url=str(raw.get("target_url", "")).rstrip("/"),
        features=features,
        ignore=tuple(raw.get("ignore", ())),
    )


def load_instances(path: Path | str | None = None) -> dict[str, Instance]:
    """Load and validate ``instances.json``: unique names, no port used twice."""
    path = Path(path) if path else DEFAULT_INSTANCES_FILE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise InstanceError(f"instances file not found: {path}") from None
    except json.JSONDecodeError as exc:
        raise InstanceError(f"{path}: invalid JSON: {exc}") from None
    items = data.get("instances")
    if not isinstance(items, list) or not items:
        raise InstanceError(f"{path}: expected a non-empty 'instances' list")
    out: dict[str, Instance] = {}
    ports: dict[int, str] = {}
    for i, raw in enumerate(items):
        inst = _parse(raw, i)
        if inst.name in out:
            raise InstanceError(f"duplicate instance name '{inst.name}'")
        for port in (inst.backend_port, inst.frontend_port):
            if port in ports:
                raise InstanceError(f"port {port} used by both '{ports[port]}' and '{inst.name}'")
            ports[port] = inst.name
        out[inst.name] = inst
    return out

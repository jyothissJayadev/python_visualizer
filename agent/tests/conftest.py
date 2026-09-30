import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))          # agent/

import pytest


@pytest.fixture(autouse=True)
def _never_touch_the_network(monkeypatch):
    """Agent tests must not report to a real collector (e.g. a developer's running instance)."""
    for var in ("VISUALIZER_SINK_URL", "BRAIN_TELEMETRY_SINK_URL", "VISUALIZER_ENABLED", "BRAIN_TELEMETRY_ENABLED"):
        monkeypatch.delenv(var, raising=False)

"""The shared agent talking to the real collector (backend.api.viewer), entirely in-process:
the agent's sink is wired to the collector app through httpx.ASGITransport, so no port is
opened and no developer's running instance can be reached."""
import sys
import time
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "agent"))

from visualizer_agent import install, monitor, trace  # noqa: E402

from backend.api import viewer  # noqa: E402
from backend.app import create_app  # noqa: E402
from backend.config import ExplorerConfig  # noqa: E402


def target_work(n):
    return n * 2


@pytest.fixture()
def wired(tmp_path, monkeypatch):
    monkeypatch.delenv("VISUALIZER_SINK_URL", raising=False)
    monkeypatch.setattr(viewer, "HUB", viewer.TelemetryHub())          # fresh collector state
    collector = create_app(ExplorerConfig(project_path=str(tmp_path)), watch=False,
                           cache_dir=tmp_path / ".cache", analyze_on_start=False)
    target = FastAPI()

    @target.get("/w/{n}")
    def w(n: int):
        return {"v": target_work(n)}

    trace.hub().clear()
    install(target, project_root=Path(__file__).parent, package_root=Path(__file__).parent, enabled=True,
            sink_url="http://collector", self_url="http://127.0.0.1:8080",
            sink_transport=httpx.ASGITransport(app=collector))
    with TestClient(target) as tc:
        yield tc, viewer.HUB
    monitor.apply_selection([])
    monitor.uninstall()


def wait_for(pred, seconds=5.0):
    end = time.time() + seconds
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.05)
    return False


def test_agent_registers_and_streams_events_into_the_collector(wired):
    tc, hub = wired
    sel = [{"id": f"{__name__}:target_work", "deep": False}]
    assert tc.post("/__telemetry__/instrument", json={"selections": sel}).json()["armed"] == [sel[0]["id"]]
    assert tc.get("/w/21").json() == {"v": 42}
    assert wait_for(lambda: any(e.get("kind") == "request.end" for e in hub.recent))
    assert hub.brain_base_url == "http://127.0.0.1:8080"                # registered via the handshake
    assert hub.brain_fingerprint
    kinds = [e["kind"] for e in hub.recent]
    assert {"request.start", "fn.start", "fn.end", "request.end"} <= set(kinds)
    start = next(e for e in hub.recent if e["kind"] == "fn.start")
    assert start["data"]["name"].endswith(":target_work") and start["data"]["args"] == {"n": "21"}
    end = next(e for e in hub.recent if e["kind"] == "fn.end")
    assert end["data"]["result"] == "42"


def test_collector_is_unaffected_by_extra_event_fields(wired):
    tc, hub = wired
    tc.get("/w/1")                                                        # unarmed: envelope only
    assert wait_for(lambda: any(e.get("kind") == "request.end" for e in hub.recent))
    end = next(e for e in hub.recent if e["kind"] == "request.end")
    assert end["data"]["status"] == 200 and end["data"]["route"] == "/w/{n}" and end["data"]["handler"] == "w"

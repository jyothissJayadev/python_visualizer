import os

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.tracer.monitor import is_supported

pytestmark = pytest.mark.skipif(not is_supported(), reason="needs sys.monitoring (Python 3.12+)")


@pytest.fixture
def client(config):
    original_cwd = os.getcwd()
    app = create_app(config)
    with TestClient(app) as test_client:
        yield test_client
    os.chdir(original_cwd)


def test_request_through_hosted_app_is_traced(client, config):
    resp = client.get(f"{config.host_app_mount}/compute/2")
    assert resp.status_code == 200
    assert resp.json() == {"result": "guarded 12"}

    summaries = client.get("/api/traces").json()
    assert len(summaries) == 1
    assert summaries[0]["label"] == f"GET {config.host_app_mount}/compute/2"
    assert summaries[0]["status_code"] == 200
    assert summaries[0]["call_count"] > 0

    detail = client.get(f"/api/traces/{summaries[0]['trace_id']}").json()
    qualnames = _qualnames(detail["roots"])
    assert "guarded" in qualnames
    assert "add" in qualnames
    guarded = _find(detail["roots"], "guarded")
    assert guarded["args"] == {"x": 2}
    assert guarded["return_value"] == "guarded 12"


def test_internal_key_is_injected(client, config):
    # /secured requires the header; caller never sends it, middleware adds it
    resp = client.get(f"{config.host_app_mount}/secured")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


def test_trace_opt_out_query_param(client, config):
    resp = client.post(f"{config.host_app_mount}/pipeline?__trace=0", json=[1, 2])
    assert resp.status_code == 200
    assert client.get("/api/traces").json() == []


def test_async_request_tree(client, config):
    resp = client.post(f"{config.host_app_mount}/pipeline", json=[3, 4])
    assert resp.status_code == 200

    summaries = client.get("/api/traces").json()
    detail = client.get(f"/api/traces/{summaries[0]['trace_id']}").json()
    root = _find(detail["roots"], "run_pipeline")
    assert root is not None
    stage = _find(root["children"], "stage")
    assert _find(stage["children"], "fetch") is not None


def test_drop_in_mount_serves_target_at_root(config):
    dropin = config.__class__(**{**config.__dict__, "host_app_mount": ""})
    app = create_app(dropin)
    with TestClient(app) as c:
        # target answers on its own unprefixed path
        assert c.get("/compute/3").json() == {"result": "guarded 18"}
        # explorer's own api still wins over the mount
        summaries = c.get("/api/traces").json()
        assert summaries[0]["label"] == "GET /compute/3"


def test_clear_traces(client, config):
    client.get(f"{config.host_app_mount}/compute/1")
    assert client.get("/api/traces").json() != []
    assert client.post("/api/traces/clear").status_code == 204
    assert client.get("/api/traces").json() == []


def _qualnames(calls):
    out = set()
    for call in calls:
        out.add(call["qualname"])
        out |= _qualnames(call["children"])
    return out


def _find(calls, qualname):
    for call in calls:
        if call["qualname"] == qualname:
            return call
        hit = _find(call["children"], qualname)
        if hit is not None:
            return hit
    return None

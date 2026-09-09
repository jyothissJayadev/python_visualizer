"""tests/api/test_terminal.py — the Brain Terminal collector
(backend/api/viewer.py): scan-based catalogue, the register handshake,
event fan-out, and the apply-selection / get-value / run-test proxies.
"""

import os
import sys

import pytest
from fastapi.testclient import TestClient

from backend.api import viewer
from backend.app import create_app
from backend.config import ExplorerConfig

SAMPLE_PROJECT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "sample_project"))


@pytest.fixture
def client():
    viewer.HUB = viewer.TelemetryHub()

    original_cwd = os.getcwd()
    original_path = list(sys.path)
    modules_before = set(sys.modules)

    app = create_app(ExplorerConfig(project_path=SAMPLE_PROJECT))
    with TestClient(app) as test_client:
        yield test_client

    os.chdir(original_cwd)
    sys.path[:] = original_path
    for name in list(sys.modules):
        if name not in modules_before:
            del sys.modules[name]


def _register(client, base_url="http://127.0.0.1:8000", fp="git:abc123def456"):
    return client.post(
        "/viewer/terminal/ingest",
        json={"kind": "register", "brain_base_url": base_url, "started_at": "2026-09-05T00:00:00+00:00", "code_fingerprint": fp},
    )


def test_serve_terminal_html(client):
    # 200 with the built dashboard when `frontend/dist` exists, otherwise a
    # 404 telling the user to build it — both are valid.
    resp = client.get("/viewer/terminal")
    assert resp.status_code in (200, 404)
    assert "Brain Terminal" in resp.text


def test_catalogue_comes_from_the_source_scan(client):
    body = client.get("/viewer/terminal/functions").json()
    all_fns = [f for g in body["groups"] for f in g["functions"]]
    ids = {f["id"] for f in all_fns}
    assert any("calculate_total" in i for i in ids)
    assert all(":" in i for i in ids)  # module:qualname
    assert "fingerprint" in body


def test_rescan_returns_a_fresh_catalogue(client):
    body = client.post("/viewer/terminal/rescan").json()
    assert body["groups"] and any("generate_workflow" in f["id"] for g in body["groups"] for f in g["functions"])


def test_register_stores_fingerprint_and_status(client):
    assert _register(client).json()["registered"] is True
    status = client.get("/viewer/terminal/status").json()
    assert status["brain_base_url"] == "http://127.0.0.1:8000"
    assert status["brain_fingerprint"] == "git:abc123def456"
    assert status["registers"] == 1


def test_apply_selection_without_brain_reports_error(client):
    with client.websocket_connect("/viewer/terminal/ws") as ws:
        ws.receive_json()  # code_status on connect
        ws.send_json({"op": "apply_selection", "selections": [{"id": "services.math_service:calculate_total", "deep": False}]})
        reply = ws.receive_json()
    assert reply["kind"] == "selection_applied"
    assert reply.get("error")
    # remembered for when brain connects
    assert viewer.HUB.selection == [{"id": "services.math_service:calculate_total", "deep": False}]


def test_events_broadcast_and_tail_replays(client):
    client.post(
        "/viewer/terminal/ingest",
        json={"kind": "events", "events": [
            {"kind": "request.start", "request_id": "req_1", "seq": 1, "data": {"method": "POST", "path": "/x"}},
        ]},
    )
    with client.websocket_connect("/viewer/terminal/ws") as ws:
        assert ws.receive_json()["kind"] == "code_status"
        replayed = ws.receive_json()
        assert replayed["request_id"] == "req_1"

        client.post(
            "/viewer/terminal/ingest",
            json={"kind": "events", "events": [
                {"kind": "fn.start", "request_id": "req_1", "span_id": "s1", "seq": 2, "data": {"name": "m:f", "args": {}}},
            ]},
        )
        live = ws.receive_json()
    assert live["kind"] == "fn.start"


def test_get_value_without_brain_replies_error(client):
    with client.websocket_connect("/viewer/terminal/ws") as ws:
        ws.receive_json()
        ws.send_json({"op": "get_value", "request_id": "r", "span_id": "s", "field": "result"})
        reply = ws.receive_json()
    assert reply["kind"] == "value" and "error" in reply["value"]


def test_run_test_without_brain_logs_error(client):
    with client.websocket_connect("/viewer/terminal/ws") as ws:
        ws.receive_json()
        ws.send_json({"op": "run_test", "domain": "quotation", "message": "hi"})
        reply = ws.receive_json()
    assert reply["kind"] == "log" and reply["data"]["level"] == "error"

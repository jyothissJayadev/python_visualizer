"""tests/api/test_terminal.py — the Brain Terminal collector
(backend/api/viewer.py): the ingest endpoint, the register handshake, and
the dashboard WebSocket's fan-out + per-socket filtering.

The sys.monitoring hosted-app tracer is not involved here — this is the
push-based path where the target posts its own telemetry.
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
    # backend.api.viewer.HUB is a module singleton — reset it per test.
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


def _register(client, base_url="http://127.0.0.1:8000"):
    return client.post(
        "/viewer/terminal/ingest",
        json={
            "kind": "register",
            "brain_base_url": base_url,
            "started_at": "2026-09-05T00:00:00+00:00",
            "catalog": {
                "groups": [
                    {"package": "quotation.graph", "functions": [
                        {"id": "quotation.graph.merge.engine:merge", "name": "merge", "signature": "(a, b)", "doc": ""},
                    ]},
                ]
            },
        },
    )


def test_serve_terminal_html(client):
    resp = client.get("/viewer/terminal")
    assert resp.status_code == 200
    assert "Brain Terminal" in resp.text


def test_register_populates_catalog_and_status(client):
    assert _register(client).json()["registered"] is True

    functions = client.get("/viewer/terminal/functions").json()
    assert functions["groups"][0]["package"] == "quotation.graph"

    status = client.get("/viewer/terminal/status").json()
    assert status["brain_base_url"] == "http://127.0.0.1:8000"
    assert status["registers"] == 1
    assert status["catalog_functions"] == 1


def test_functions_falls_back_to_demo_catalogue_before_register(client):
    body = client.get("/viewer/terminal/functions").json()
    assert body["groups"] and all("functions" in g for g in body["groups"])


def test_ingested_events_broadcast_to_a_connected_dashboard(client):
    with client.websocket_connect("/viewer/terminal/ws") as ws:
        client.post(
            "/viewer/terminal/ingest",
            json={"kind": "events", "events": [
                {"kind": "request.start", "request_id": "req_1", "seq": 1, "data": {"method": "POST", "path": "/x"}},
                {"kind": "request.end", "request_id": "req_1", "seq": 2, "data": {"status": 200, "duration_ms": 5}},
            ]},
        )
        first = ws.receive_json()
        second = ws.receive_json()

    assert first["kind"] == "request.start" and first["request_id"] == "req_1"
    assert second["kind"] == "request.end" and second["data"]["status"] == 200


def test_late_dashboard_gets_the_recent_tail_replayed(client):
    client.post(
        "/viewer/terminal/ingest",
        json={"kind": "events", "events": [
            {"kind": "request.start", "request_id": "req_old", "seq": 1, "data": {"method": "GET", "path": "/old"}},
        ]},
    )
    with client.websocket_connect("/viewer/terminal/ws") as ws:
        replayed = ws.receive_json()
    assert replayed["request_id"] == "req_old"


def test_selected_only_verbosity_filters_function_events_per_socket(client):
    with client.websocket_connect("/viewer/terminal/ws") as ws:
        ws.send_json({"op": "set_verbosity", "level": "selected"})
        ws.send_json({"op": "select", "functions": ["quotation.graph.merge.engine:merge"]})

        client.post(
            "/viewer/terminal/ingest",
            json={"kind": "events", "events": [
                {"kind": "request.start", "request_id": "r", "seq": 1, "data": {"method": "POST", "path": "/p"}},
                {"kind": "fn.start", "request_id": "r", "span_id": "s1", "seq": 2,
                 "data": {"name": "quotation.graph.merge.engine:merge", "args": {}}},
                {"kind": "fn.start", "request_id": "r", "span_id": "s2", "seq": 3,
                 "data": {"name": "quotation.graph.other:noise", "args": {}}},
                {"kind": "request.end", "request_id": "r", "seq": 4, "data": {"status": 200, "duration_ms": 1}},
            ]},
        )

        got = [ws.receive_json() for _ in range(3)]

    kinds = [(e["kind"], e.get("data", {}).get("name")) for e in got]
    assert kinds == [
        ("request.start", None),
        ("fn.start", "quotation.graph.merge.engine:merge"),
        ("request.end", None),
    ]


def test_get_value_without_registered_brain_replies_with_an_error(client):
    with client.websocket_connect("/viewer/terminal/ws") as ws:
        ws.send_json({"op": "get_value", "request_id": "r", "span_id": "s", "field": "result"})
        reply = ws.receive_json()
    assert reply["kind"] == "value"
    assert "error" in reply["value"]


def test_run_test_without_registered_brain_logs_an_error(client):
    with client.websocket_connect("/viewer/terminal/ws") as ws:
        ws.send_json({"op": "run_test", "domain": "quotation", "message": "hi"})
        reply = ws.receive_json()
    assert reply["kind"] == "log" and reply["data"]["level"] == "error"

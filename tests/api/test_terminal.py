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
def client(tmp_path):
    viewer.HUB = viewer.TelemetryHub()

    original_cwd = os.getcwd()
    original_path = list(sys.path)
    modules_before = set(sys.modules)

    # analysis off: its analysis_* broadcasts would interleave with the
    # collector messages these tests assert on (see test_routes_api.py).
    # cache_dir is isolated per test (tmp_path) so the templates store
    # doesn't write into the repo's real .cache/ during test runs.
    app = create_app(
        ExplorerConfig(project_path=SAMPLE_PROJECT), analyze_on_start=False, cache_dir=tmp_path / "cache"
    )
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


def test_register_tolerates_url_with_trailing_comment(client):
    # `set BRAIN_TELEMETRY_SELF_URL=http://host  # note` on Windows keeps the
    # note in the value — the collector must still recover a usable base URL.
    _register(client, base_url="http://127.0.0.1:8000   # brain's own base URL")
    assert client.get("/viewer/terminal/status").json()["brain_base_url"] == "http://127.0.0.1:8000"


def test_register_logs_once_then_heartbeats_are_silent(client):
    with client.websocket_connect("/viewer/terminal/ws") as ws:
        ws.receive_json()  # code_status on connect

        _register(client)  # first registration → visible log line
        first = ws.receive_json()
        assert first["kind"] == "log" and "brain registered" in first["data"]["line"]
        assert ws.receive_json()["kind"] == "code_status"

        _register(client)  # same started_at → heartbeat, no log line
        assert ws.receive_json()["kind"] == "code_status"

        _register(client, fp="git:restarted", base_url="http://127.0.0.1:8000")
        # still the same started_at in the helper → still silent
        assert ws.receive_json()["kind"] == "code_status"

        # a real restart (new started_at) logs again
        client.post(
            "/viewer/terminal/ingest",
            json={"kind": "register", "brain_base_url": "http://127.0.0.1:8000",
                  "started_at": "2026-09-06T00:00:00+00:00", "code_fingerprint": "git:abc"},
        )
        again = ws.receive_json()
        assert again["kind"] == "log" and "brain registered" in again["data"]["line"]


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


def test_clear_op_drops_buffer_and_broadcasts(client):
    client.post(
        "/viewer/terminal/ingest",
        json={"kind": "events", "events": [
            {"kind": "request.start", "request_id": "req_1", "seq": 1, "data": {"method": "GET", "path": "/x"}},
        ]},
    )
    assert len(viewer.HUB.recent) == 1
    with client.websocket_connect("/viewer/terminal/ws") as ws:
        ws.receive_json()  # code_status
        ws.receive_json()  # replayed req_1
        ws.send_json({"op": "clear"})
        cleared = ws.receive_json()
    assert cleared["kind"] == "cleared"
    assert len(viewer.HUB.recent) == 0

    # a fresh dashboard now replays nothing
    with client.websocket_connect("/viewer/terminal/ws") as ws2:
        assert ws2.receive_json()["kind"] == "code_status"


def test_get_value_without_brain_replies_error(client):
    with client.websocket_connect("/viewer/terminal/ws") as ws:
        ws.receive_json()
        ws.send_json({"op": "get_value", "request_id": "r", "span_id": "s", "field": "result"})
        reply = ws.receive_json()
    assert reply["kind"] == "value" and "error" in reply and "value" not in reply


def test_rest_traces_and_selection(client):
    # Ingest some sample events
    client.post(
        "/viewer/terminal/ingest",
        json={"kind": "events", "events": [
            {"kind": "fn.start", "request_id": "req_1", "span_id": "s1", "data": {"name": "services.math:calculate", "fn_id": "services.math:calculate"}},
            {"kind": "fn.end", "request_id": "req_1", "span_id": "s1", "data": {"name": "services.math:calculate", "fn_id": "services.math:calculate"}},
            {"kind": "fn.start", "request_id": "req_2", "span_id": "s2", "data": {"name": "utils.text:format", "fn_id": "utils.text:format"}},
        ]},
    )

    # Test trace query
    traces = client.get("/viewer/terminal/traces?limit=10").json()
    assert len(traces) == 3

    # Test filtered by function_id
    math_traces = client.get("/viewer/terminal/traces?function_id=calculate").json()
    assert len(math_traces) == 2

    # Test filtered by request_id
    req2_traces = client.get("/viewer/terminal/traces?request_id=req_2").json()
    assert len(req2_traces) == 1

    # Test REST selection without brain
    sel_res = client.post("/viewer/terminal/selection", json={"selections": [{"id": "services.math:calculate", "deep": True}]}).json()
    assert sel_res["ok"] is False
    assert viewer.HUB.selection == [{"id": "services.math:calculate", "deep": True}]



def test_selection_update_merges_removes_and_clears(client):
    client.post("/viewer/terminal/selection/update", json={"add": [{"id": "a:f", "deep": False}, {"id": "b:g", "deep": True}]})
    assert client.get("/viewer/terminal/selection").json()["selection"] == [
        {"id": "a:f", "deep": False}, {"id": "b:g", "deep": True}]

    # add merges (and updates deep), never wipes the rest
    client.post("/viewer/terminal/selection/update", json={"add": [{"id": "a:f", "deep": True}]})
    assert {s["id"]: s["deep"] for s in viewer.HUB.selection} == {"a:f": True, "b:g": True}

    client.post("/viewer/terminal/selection/update", json={"remove": ["a:f"]})
    assert [s["id"] for s in viewer.HUB.selection] == ["b:g"]

    res = client.post("/viewer/terminal/selection/update", json={"clear": True}).json()
    assert res["ok"] is False and res["error"] == "brain not registered"
    assert viewer.HUB.selection == []


def test_clear_traces_endpoint(client):
    client.post("/viewer/terminal/ingest", json={"events": [{"kind": "fn.start", "request_id": "r1", "span_id": "s"}]})
    assert client.post("/viewer/terminal/traces/clear").json() == {"ok": True, "dropped": 1}
    assert client.get("/viewer/terminal/traces").json() == []


def test_send_request_needs_brain_and_rejects_absolute_urls(client):
    assert client.post("/viewer/terminal/request", json={"path": "/x"}).status_code == 503
    _register(client)
    bad = client.post("/viewer/terminal/request", json={"path": "http://evil.example/x"})
    assert bad.status_code == 400
    assert client.post("/viewer/terminal/request", json={"path": "//evil.example"}).status_code == 400


def test_send_request_reports_request_ids(client, monkeypatch):
    _register(client)

    async def fake(method, url, body, headers, timeout=30.0):
        viewer.HUB.recent.append({"kind": "fn.start", "request_id": "req_9", "span_id": "s", "ts": viewer._now() + 1})
        return {"status": 200, "headers": {}, "body": {"ok": 1}}

    monkeypatch.setattr(viewer, "_http_request", fake)
    res = client.post("/viewer/terminal/request", json={"method": "get", "path": "/ping"}).json()
    assert res["ok"] and res["status"] == 200 and res["request_ids"] == ["req_9"]


# ─────────────────────────────────────────────────────────────────────────
# Trace Templates
# ─────────────────────────────────────────────────────────────────────────
def _real_function_id(client) -> str:
    catalog = client.get("/viewer/terminal/functions").json()
    for group in catalog["groups"]:
        for fn in group["functions"]:
            if "calculate_total" in fn["id"]:
                return fn["id"]
    raise AssertionError("sample_project has no calculate_total function")


def test_template_crud_round_trip(client):
    fid = _real_function_id(client)
    created = client.post(
        "/viewer/terminal/templates", json={"name": "checkout", "functions": [{"id": fid, "deep": True}]}
    ).json()["template"]
    assert created["name"] == "checkout"
    assert created["functions"] == [{"id": fid, "deep": True}]

    listed = client.get("/viewer/terminal/templates").json()["templates"]
    assert len(listed) == 1
    assert listed[0]["functions"][0]["status"] == "ok"

    updated = client.put(
        f"/viewer/terminal/templates/{created['id']}", json={"name": "checkout flow"}
    ).json()["template"]
    assert updated["name"] == "checkout flow"
    assert updated["functions"] == [{"id": fid, "deep": True}]  # untouched field preserved

    assert client.delete(f"/viewer/terminal/templates/{created['id']}").json() == {"ok": True}
    assert client.get("/viewer/terminal/templates").json()["templates"] == []


def test_template_validation_rejects_empty_and_duplicate_names(client):
    fid = _real_function_id(client)
    payload = {"name": "checkout", "functions": [{"id": fid, "deep": False}]}
    first = client.post("/viewer/terminal/templates", json=payload)
    assert first.status_code == 201

    dup = client.post("/viewer/terminal/templates", json=payload)
    assert dup.status_code == 409

    empty_name = client.post("/viewer/terminal/templates", json={"name": "  ", "functions": [{"id": fid}]})
    assert empty_name.status_code == 400

    empty_functions = client.post("/viewer/terminal/templates", json={"name": "other", "functions": []})
    assert empty_functions.status_code == 400


def test_template_rename_to_self_is_not_a_duplicate(client):
    fid = _real_function_id(client)
    created = client.post(
        "/viewer/terminal/templates", json={"name": "Checkout", "functions": [{"id": fid, "deep": False}]}
    ).json()["template"]

    # case-only correction of its own name must not be rejected as a duplicate
    res = client.put(f"/viewer/terminal/templates/{created['id']}", json={"name": "checkout"})
    assert res.status_code == 200
    assert res.json()["template"]["name"] == "checkout"


def test_template_missing_function_is_flagged_with_suggestion(client):
    real_fid = _real_function_id(client)
    stale_fid = real_fid + "_renamed"  # not in the catalog, but close to a real id
    client.post("/viewer/terminal/templates", json={"name": "stale", "functions": [{"id": stale_fid, "deep": False}]})

    listed = client.get("/viewer/terminal/templates").json()["templates"][0]["functions"][0]
    assert listed["status"] == "missing"
    assert real_fid in listed["suggestions"]


def test_template_apply_persists_and_arms_selection_with_saved_mode(client):
    fid = _real_function_id(client)
    created = client.post(
        "/viewer/terminal/templates", json={"name": "checkout", "functions": [{"id": fid, "deep": True}]}
    ).json()["template"]

    res = client.post(f"/viewer/terminal/templates/{created['id']}/apply").json()
    assert res["ok"] is False  # no brain registered, matches set_terminal_selection's own contract
    assert res["error"] == "brain not registered"
    assert viewer.HUB.selection == [{"id": fid, "deep": True}]


def test_template_apply_pushes_unresolved_functions_unconditionally(client, monkeypatch):
    """apply must behave exactly like arm_functions/set_terminal_selection: it
    pushes every saved function to brain regardless of local catalog status —
    it never pre-filters using the static AST scan."""
    fid = _real_function_id(client)
    stale_fid = "totally.made.up:function"
    created = client.post(
        "/viewer/terminal/templates",
        json={"name": "mixed", "functions": [{"id": fid, "deep": False}, {"id": stale_fid, "deep": True}]},
    ).json()["template"]

    _register(client)
    pushed = {}

    async def fake_push_selection(selection):
        pushed["selection"] = selection
        return {"armed": [s["id"] for s in selection], "unresolved": []}

    monkeypatch.setattr(viewer, "_push_selection", fake_push_selection)
    client.post(f"/viewer/terminal/templates/{created['id']}/apply")
    # both ids were sent to HUB.selection and on to _push_selection — neither
    # was silently dropped because it failed the local catalog check.
    assert {s["id"] for s in viewer.HUB.selection} == {fid, stale_fid}
    assert {s["id"] for s in pushed["selection"]} == {fid, stale_fid}


def test_template_not_found_returns_404(client):
    assert client.put("/viewer/terminal/templates/tpl_missing", json={"name": "x"}).status_code == 404
    assert client.delete("/viewer/terminal/templates/tpl_missing").status_code == 404
    assert client.post("/viewer/terminal/templates/tpl_missing/apply").status_code == 404


def test_templates_persist_across_a_fresh_store_for_the_same_project(client, tmp_path):
    from backend.analysis.templates import TemplateStore

    fid = _real_function_id(client)
    client.post("/viewer/terminal/templates", json={"name": "checkout", "functions": [{"id": fid, "deep": False}]})

    # simulate a backend restart: a brand-new TemplateStore instance for the
    # same project_path/cache_dir must load what was already saved to disk.
    reloaded = TemplateStore(SAMPLE_PROJECT, tmp_path / "cache")
    assert [t["name"] for t in reloaded.list_raw()] == ["checkout"]

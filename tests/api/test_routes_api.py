"""tests/api/test_routes_api.py — the Routes view API (backend/api/routes.py)
and the AnalysisService behind it (fingerprint, refresh, cache, watcher)."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.api import viewer
from backend.app import create_app
from backend.config import ExplorerConfig

FILES = {
    "app/__init__.py": "",
    "app/svc.py": (
        "def load(i):\n"
        "    '''Load one thing.'''\n"
        "    return norm(i)\n"
        "def norm(i):\n"
        "    return i\n"
    ),
    "app/main.py": (
        "from fastapi import FastAPI\n"
        "from app.svc import load\n"
        "app = FastAPI()\n"
        "@app.get('/things/{id}')\n"
        "async def get_thing(id: str):\n"
        "    '''Fetch a thing.'''\n"
        "    for _ in range(2):\n"
        "        load(id)\n"
        "    return load(id)\n"
    ),
}


def _project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    for rel, src in FILES.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(src, encoding="utf-8")
    return root


def _wait_ready(client: TestClient, min_generation: int = 1, timeout: float = 10.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = client.get("/viewer/routes/status").json()
        if status["ready"] and status["generation"] >= min_generation and status["status"] == "idle":
            return status
        time.sleep(0.05)
    raise AssertionError("analysis never became ready")


@pytest.fixture
def make_client(tmp_path: Path):
    viewer.HUB = viewer.TelemetryHub()
    clients: list[TestClient] = []

    def factory(watch: bool = False) -> tuple[TestClient, Path]:
        root = _project(tmp_path)
        app = create_app(ExplorerConfig(project_path=str(root)), watch=watch, cache_dir=tmp_path / "cache")
        c = TestClient(app)
        c.__enter__()
        clients.append(c)
        return c, root

    yield factory
    for c in clients:
        c.__exit__(None, None, None)


def test_list_endpoint_tree_and_function(make_client):
    client, _ = make_client()
    _wait_ready(client)

    listing = client.get("/viewer/routes").json()
    assert listing["analysis"]["ready"] is True
    assert [g["prefix"] for g in listing["groups"]] == ["/things"]
    ep = listing["groups"][0]["endpoints"][0]
    assert (ep["id"], ep["summary"]) == ("GET /things/{id}", "Fetch a thing.")

    detail = client.get("/viewer/routes/endpoint", params={"id": ep["id"]}).json()
    assert detail["handler_id"] == "app.main:get_thing"

    # functions only: the `for` loop is dissolved, and the two `load(id)` calls
    # collapse into one node (x2). depth=1 shows load, cut before norm.
    shallow = client.get("/viewer/routes/tree", params={"id": ep["id"], "depth": 1}).json()
    load = shallow["node"]["children"][0]
    assert load["function_id"] == "app.svc:load" and load["meta"]["count"] == 2
    assert "children" not in load and load["children_count"] == 1
    assert shallow["stats"]["function"] == 3

    # expand the cut node by its id
    sub = client.get("/viewer/routes/tree", params={"id": ep["id"], "path": load["id"], "depth": 3}).json()
    assert sub["node"]["children"][0]["function_id"] == "app.svc:norm"

    fn = client.get("/viewer/routes/function", params={"id": "app.svc:load"}).json()
    assert fn["docstring"] == "Load one thing." and fn["source"].startswith("def load(i):")

    assert client.get("/viewer/routes/tree", params={"id": ep["id"], "path": "0.99"}).status_code == 404
    assert client.get("/viewer/routes/endpoint", params={"id": "GET /nope"}).status_code == 404
    assert client.get("/viewer/routes/function", params={"id": "app.svc:nope"}).status_code == 404


def test_rescan_picks_up_code_changes_and_fingerprint_is_stable(make_client):
    client, root = make_client()
    first = _wait_ready(client)
    assert client.get("/viewer/routes/status").json()["stale"] is False

    # nothing changed -> refresh is a no-op
    assert client.app.state.analysis_service.fingerprint == first["fingerprint"]

    (root / "app" / "extra.py").write_text(
        "from app.main import app\n@app.post('/extra')\ndef extra(): ...\n", encoding="utf-8"
    )
    assert client.get("/viewer/routes/status").json()["stale"] is True  # code moved on, analysis hasn't

    result = client.post("/viewer/routes/rescan").json()
    assert result["changed"] is True and result["generation"] == first["generation"] + 1
    ids = {e["id"] for g in client.get("/viewer/routes").json()["groups"] for e in g["endpoints"]}
    assert ids == {"GET /things/{id}", "POST /extra"}
    assert client.get("/viewer/routes/status").json()["stale"] is False


def test_disk_cache_serves_routes_before_first_analysis(make_client, tmp_path: Path):
    client, _ = make_client()
    _wait_ready(client)  # writes the cache
    from backend.analysis.service import AnalysisService

    svc = AnalysisService(ExplorerConfig(project_path=str(tmp_path / "proj")), cache_dir=tmp_path / "cache")
    svc._load_cache()
    assert svc.analysis is None and svc.cached_routes is not None
    assert [e["id"] for e in svc.cached_routes["endpoints"]] == ["GET /things/{id}"]
    assert svc.status_payload()["from_cache"] is True


def test_file_watcher_reanalyses_and_broadcasts(make_client):
    client, root = make_client(watch=True)
    first = _wait_ready(client)
    time.sleep(0.5)  # let the watcher establish itself
    (root / "app" / "extra.py").write_text(
        "from app.main import app\n@app.post('/watched')\ndef watched(): ...\n", encoding="utf-8"
    )
    status = _wait_ready(client, min_generation=first["generation"] + 1, timeout=15)
    ids = {e["id"] for g in client.get("/viewer/routes").json()["groups"] for e in g["endpoints"]}
    assert "POST /watched" in ids and status["reason"] == "file change"


def _ingest(client, events):
    return client.post("/viewer/terminal/ingest", json={"events": events})


def test_runtime_overlay_and_arm(make_client):
    client, _ = make_client()
    _wait_ready(client)
    eid = "GET /things/{id}"

    empty = client.get("/viewer/routes/runtime", params={"id": eid}).json()
    assert empty["request_count"] == 0 and empty["functions"] == {}

    def ev(kind, sid=None, parent=None, ts=1.0, **data):
        return {"kind": kind, "request_id": "r1", "span_id": sid, "parent_span_id": parent, "ts": ts, "data": data}

    _ingest(client, [
        ev("request.start", ts=1, method="GET", path="/things/42"),
        ev("fn.start", "a", None, 1.1, name="app.main:get_thing"),
        ev("fn.start", "b", "a", 1.2, name="app.svc:load"),
        ev("fn.end", "b", "a", 1.3, name="app.svc:load", duration_ms=12, result=42),
        ev("fn.start", "c", "a", 1.4, name="app.svc:surprise"),
        ev("fn.end", "c", "a", 1.5, name="app.svc:surprise", duration_ms=1),
        ev("fn.end", "a", None, 1.6, name="app.main:get_thing", duration_ms=50),
        ev("request.end", ts=2, status=200, duration_ms=60),
    ])
    ov = client.get("/viewer/routes/runtime", params={"id": eid}).json()
    assert ov["request_count"] == 1 and ov["span_count"] == 3
    assert ov["functions"]["app.svc:load"]["last"]["result"] == 42
    assert "app.main:get_thing>app.svc:load" in ov["confirmed"]
    assert [x["function_id"] for x in ov["extras"]["app.main:get_thing"]] == ["app.svc:surprise"]
    assert client.get("/viewer/routes/runtime", params={"id": "GET /nope"}).status_code == 404

    # arming without brain connected is remembered and reported, not an error
    res = client.post("/viewer/routes/arm", json={"id": eid}).json()
    assert res["ok"] is False and "not connected" in res["error"]
    assert viewer.HUB.selection == [{"id": "app.main:get_thing", "deep": True}]
    assert client.get("/viewer/routes/runtime", params={"id": eid}).json()["armed"] == {"app.main:get_thing": True}
    client.post("/viewer/routes/arm", json={"id": eid, "armed": False})
    assert viewer.HUB.selection == []


def test_missing_project_path_is_an_error_not_an_empty_success(tmp_path: Path):
    viewer.HUB = viewer.TelemetryHub()
    missing = tmp_path / "does" / "not" / "exist"
    app = create_app(ExplorerConfig(project_path=str(missing)), watch=True, cache_dir=None)
    with TestClient(app) as client:
        deadline = time.time() + 5
        status = client.get("/viewer/routes/status").json()
        while status["status"] != "error" and time.time() < deadline:
            time.sleep(0.05)
            status = client.get("/viewer/routes/status").json()
        assert status["status"] == "error" and "does not exist" in status["error"]
        assert status["ready"] is False
        assert client.get("/viewer/routes/endpoint", params={"id": "GET /x"}).status_code == 503


def test_cli_rejects_a_nonexistent_project(capsys):
    from backend.main import parse_args

    with pytest.raises(SystemExit):
        parse_args(["--project", "/path/to/atomics_estimate_engine/apps/brain"])
    err = capsys.readouterr().err
    assert "does not exist" in err and "placeholder" in err

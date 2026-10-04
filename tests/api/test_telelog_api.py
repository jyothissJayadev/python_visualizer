from __future__ import annotations

from pathlib import Path

import pytest
from starlette.testclient import TestClient

from backend.app import create_app
from backend.config import ExplorerConfig
from tests.analysis.test_map import FILES
from tests.analysis.test_telelog_store import tag


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    for rel, src in FILES.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(src, encoding="utf-8")
    return root


@pytest.fixture
def client(project: Path, tmp_path: Path):
    app = create_app(ExplorerConfig(project_path=str(project)), watch=False, cache_dir=tmp_path / ".cache",
                     analyze_on_start=False)
    with TestClient(app) as c:
        yield c


def test_validate_and_untagged_flow(client: TestClient, project: Path):
    v = client.get("/viewer/telelog/validate").json()
    assert v["ok"] is False and v["by_code"] == {"missing-tag": 6}
    page = client.get("/viewer/telelog/untagged", params={"limit": 2}).json()
    assert [i["id"] for i in page["items"]] == ["app.api:get_orders", "app.api:post_order"]
    assert page["next_cursor"] and page["total_untagged"] == 6
    nxt = client.get("/viewer/telelog/untagged", params={"limit": 50, "cursor": page["next_cursor"]}).json()
    assert len(nxt["items"]) == 4 and nxt["next_cursor"] is None


def test_answers_are_fresh_after_an_edit_without_a_rescan(client: TestClient, project: Path):
    assert client.get("/viewer/telelog/validate").json()["tagged"] == 0
    tag(project, "app/utils.py", "def norm", "norm")  # edit on disk; nothing told the service
    v = client.get("/viewer/telelog/validate").json()
    assert v["tagged"] == 1 and v["by_code"]["missing-tag"] == 5
    with (project / "app/utils.py").open("a") as f:
        f.write("def brand_new():\n    return 1\n")
    ids = [i["id"] for i in client.get("/viewer/telelog/untagged", params={"limit": 100}).json()["items"]]
    assert "app.utils:brand_new" in ids  # the analysis was refreshed, not served stale


def test_function_features_parent_and_errors(client: TestClient, project: Path):
    tag(project, "app/services.py", "async def create_order", "create_order")
    f = client.get("/viewer/telelog/function", params=[("ids", "app.services:create_order"), ("ids", "x:y")]).json()
    assert f[0]["tag"]["feature"] == "Orders" and f[1]["error"] == "not found"
    feats = client.get("/viewer/telelog/features").json()["features"]
    assert [x["name"] for x in feats] == ["Orders"]
    p = client.get("/viewer/telelog/parent", params={"id": "app.utils:norm"}).json()
    assert p[0]["id"] == "app.services:create_order"
    assert client.get("/viewer/telelog/parent", params={"id": "nope:x"}).status_code == 404
    assert client.get("/viewer/telelog/function").status_code == 422  # ids required


def test_progress_verify_and_hook_changed_cycle(client: TestClient, project: Path):
    tag(project, "app/utils.py", "def norm", "norm")
    r = client.post("/viewer/telelog/progress", json={"ids": ["app.utils:norm"]}).json()
    assert r["verified"] == ["app.utils:norm"] and r["count"] == 1
    assert client.get("/viewer/telelog/progress").json()["done"] == ["app.utils:norm"]
    assert client.get("/viewer/telelog/changed", params={"paths": "app/utils.py"}).json()["changed"] == []
    p = project / "app/utils.py"
    p.write_text(p.read_text().replace("str(x).strip()", "str(x).strip().lower()"))
    ch = client.get("/viewer/telelog/changed", params={"paths": "app/utils.py"}).json()
    assert [c["id"] for c in ch["changed"]] == ["app.utils:norm"]  # body changed, tag not re-verified
    client.post("/viewer/telelog/progress", json={"ids": ["app.utils:norm"]})  # agent refreshed the tag
    assert client.get("/viewer/telelog/changed", params={"paths": "app/utils.py"}).json()["changed"] == []
    assert client.delete("/viewer/telelog/progress").json() == {"ok": True}
    assert client.get("/viewer/telelog/progress").json()["count"] == 0
    assert client.get("/viewer/telelog/untagged", params={"limit": 0}).status_code == 422


def test_config_excludes_apply(client: TestClient, project: Path):
    (project / ".telelog").mkdir()
    (project / ".telelog" / "config").write_text("exclude: app/utils.py\n", encoding="utf-8")
    v = client.get("/viewer/telelog/validate").json()
    assert v["functions"] == 4 and v["by_code"] == {"missing-tag": 4}


def test_map_endpoint_always_answers_and_live_endpoint_redacts(client: TestClient, project: Path):
    m = client.get("/viewer/telelog/map").json()
    assert m["features"] == [] and m["coverage"] == {"tagged": 0, "total": 6, "stale": 0, "invalid": 0}
    assert "app.api" in m["untagged"]  # the module-grouped fallback
    p = project / "app/services.py"
    text = p.read_text()
    p.write_text(text.replace(
        "async def create_order",
        "# @telelog id=app.services::create_order role=sub feature=Orders parent=- n=1\n"
        "# purpose: p\n# in: body (JWT)\n# out: items\nasync def create_order", 1))
    assert client.get("/viewer/telelog/map").json()["coverage"]["tagged"] == 1
    from backend.api import viewer
    assert client.get("/viewer/telelog/live", params={"id": "app.services:create_order"}).json()["status"] == "no-trace"
    viewer.HUB.recent.append({"kind": "fn.start", "request_id": "r", "span_id": "s", "ts": 1,
                              "data": {"name": "app.services:create_order", "args": {"body": {"secret": 1}}}})
    try:
        live = client.get("/viewer/telelog/live", params={"id": "app.services:create_order"}).json()
        assert live["inputs"]["body"] == {"state": "redacted"} and "secret" not in str(live)
    finally:
        viewer.HUB.recent.pop()
    assert client.get("/viewer/telelog/live", params={"id": "nope:x"}).status_code == 404


def test_flow_endpoint(client: TestClient, project: Path):
    f = client.get("/viewer/telelog/flow", params={"id": "app.api:post_order"}).json()
    assert f["route"] == "POST /orders" and f["steps"][0]["id"] == "app.api:post_order" and len(f["steps"]) == 8
    assert client.get("/viewer/telelog/flow", params={"id": "nope:x"}).status_code == 404

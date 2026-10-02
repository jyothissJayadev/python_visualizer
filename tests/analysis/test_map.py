from __future__ import annotations

from pathlib import Path

import pytest
from starlette.testclient import TestClient

from backend.analysis.algorithm import AlgorithmStore, card, skeleton, validate_fill
from backend.analysis.engine import Analysis
from backend.analysis.mapmodel import build_map
from backend.app import create_app
from backend.config import ExplorerConfig

FILES = {
    "app/__init__.py": "",
    "app/main.py": (
        "from fastapi import FastAPI\n"
        "from app.api import router\n"
        "app = FastAPI()\n"
        "app.include_router(router)\n"
    ),
    "app/api.py": (
        "from fastapi import APIRouter\n"
        "from app.services import create_order, list_orders\n"
        "router = APIRouter()\n"
        "@router.post('/orders')\n"
        "async def post_order(body: dict):\n"
        "    return await create_order(body)\n"
        "@router.get('/orders')\n"
        "async def get_orders():\n"
        "    return await list_orders()\n"
    ),
    "app/services.py": (
        "import httpx\n"
        "from app.utils import norm, _tiny\n"
        "async def create_order(body):\n"
        "    if not body:\n"
        "        raise ValueError('empty')\n"
        "    items = []\n"
        "    for x in body.get('items', []):\n"
        "        items.append(norm(x))\n"
        "    async with httpx.AsyncClient() as c:\n"
        "        await c.post('http://pay', json=items)\n"
        "    return await list_orders()\n"
        "async def list_orders():\n"
        "    try:\n"
        "        return [norm(i) for i in range(3)]\n"
        "    except Exception:\n"
        "        return _tiny()\n"
    ),
    "app/utils.py": "def norm(x):\n    return str(x).strip()\ndef _tiny():\n    return []\n",
}


@pytest.fixture
def project(tmp_path: Path) -> Path:
    for rel, src in FILES.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(src, encoding="utf-8")
    return tmp_path


@pytest.fixture
def analysis(project: Path) -> Analysis:
    return Analysis(str(project))


def test_entry_points_and_roles(analysis: Analysis):
    m = build_map(analysis)
    assert [e["id"] for e in m["entry_points"]] == ["app.main:app"]
    f = m["functions"]
    assert f["app.api:post_order"]["role"] == "main"  # handler
    assert f["app.services:create_order"]["role"] == "main"  # io + loop + branching
    assert f["app.utils:norm"]["role"] == "child"  # leaf helper
    assert f["app.utils:norm"]["shared"] is True  # used by two mains
    assert set(f["app.utils:norm"]["used_by"]) == {"app.services:create_order", "app.services:list_orders"}
    assert "app.utils:norm" in f["app.services:create_order"]["children"]


def test_edges_connect_mains(analysis: Analysis):
    m = build_map(analysis)
    pairs = {(e["from"], e["to"]) for e in m["edges"]}
    assert ("app.api:post_order", "app.services:create_order") in pairs
    assert ("app.services:create_order", "app.services:list_orders") in pairs
    assert m["stats"]["main"] + m["stats"]["child"] == m["stats"]["functions"]


def test_override_pins_role(analysis: Analysis):
    m = build_map(analysis, {"app.utils:norm": "main"})
    assert m["functions"]["app.utils:norm"]["role"] == "main"
    assert m["functions"]["app.utils:norm"]["reasons"][0].startswith("pinned main")


def test_skeleton_is_deterministic_and_locked(analysis: Analysis):
    a = skeleton(analysis, "app.services:create_order")
    b = skeleton(Analysis(analysis.routes.project_path), "app.services:create_order")
    assert a == b
    assert a["facts"]["raises"] == ["ValueError"]

    def flat(steps):
        for s in steps:
            yield s
            yield from flat(s["children"])

    kinds = [s["kind"] for s in flat(a["steps"])]
    assert {"branch", "arm", "raise", "loop", "return"} <= set(kinds)  # decisions without calls are kept
    refs = {s["ref"] for s in flat(a["steps"]) if s["kind"] == "function"}
    assert refs == {"app.utils:norm", "app.services:list_orders"}
    ids = [s["id"] for s in flat(a["steps"])]
    assert len(ids) == len(set(ids))


def test_fill_cannot_change_structure(analysis: Analysis):
    skel = skeleton(analysis, "app.services:create_order")
    good = {"function_id": skel["function_id"], "body_hash": skel["body_hash"], "purpose": "Create an order.",
            "steps": {skel["steps"][0]["id"]: {"label": "First step"}}}
    assert validate_fill(skel, good) == []
    assert validate_fill(skel, {**good, "steps": {"99": {"label": "x"}}})  # invented step
    assert validate_fill(skel, {**good, "body_hash": "stale"})
    assert validate_fill(skel, {**good, "steps": {skel["steps"][0]["id"]: {"children": []}}})
    c = card(skel, good, "filled")
    assert c["purpose"] == "Create an order." and c["steps"][0]["label"] == "First step"
    assert [s["id"] for s in c["steps"]] == [s["id"] for s in skel["steps"]]
    assert c["facts"] == skel["facts"]


def test_stale_fill_falls_back(analysis: Analysis, tmp_path: Path):
    skel = skeleton(analysis, "app.services:create_order")
    store = AlgorithmStore(tmp_path / "algos")
    fill = {"function_id": skel["function_id"], "body_hash": "old", "purpose": "x", "steps": {}}
    assert store.put(skel, fill)  # rejected: stale
    assert store.get(skel["function_id"]) is None
    assert store.card(analysis, skel["function_id"])["fill_status"] == "deterministic"
    fill["body_hash"] = skel["body_hash"]
    assert store.put(skel, fill) == []
    assert store.card(analysis, skel["function_id"])["fill_status"] == "filled"


def test_map_api(project: Path, tmp_path: Path):
    app = create_app(ExplorerConfig(project_path=str(project)), watch=False, cache_dir=tmp_path / ".cache",
                     analyze_on_start=False)
    with TestClient(app) as client:
        assert client.get("/viewer/map").status_code == 503
        app.state.analysis_service.analysis = Analysis(str(project))
        m = client.get("/viewer/map").json()
        assert m["stats"]["main"] >= 3
        fid = "app.services:create_order"
        c = client.get("/viewer/map/algorithm", params={"id": fid}).json()
        assert c["fill_status"] == "deterministic"
        fill = {"function_id": fid, "body_hash": c["body_hash"], "purpose": "Creates an order", "steps": {}}
        assert client.put("/viewer/map/algorithm", json={"fill": fill}).status_code == 200
        assert client.get("/viewer/map/algorithm", params={"id": fid}).json()["fill_status"] == "filled"
        bad = {**fill, "steps": {"77": {"label": "x"}}}
        assert client.put("/viewer/map/algorithm", json={"fill": bad}).status_code == 422
        assert client.get("/viewer/map/algorithm", params={"id": "nope:x"}).status_code == 404
        r = client.put("/viewer/map/overrides", json={"id": "app.utils:norm", "role": "main"}).json()
        assert r == {"app.utils:norm": "main"}
        assert client.get("/viewer/map").json()["functions"]["app.utils:norm"]["role"] == "main"

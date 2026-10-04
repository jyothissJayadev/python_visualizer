from __future__ import annotations

import json
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from backend.analysis import telelog_tools as tools
from backend.analysis.engine import Analysis
from backend.analysis.mapmodel import build_map
from backend.analysis.telelog import current_fingerprints, read_tags, tagged_function_ids
from backend.app import create_app
from backend.config import ExplorerConfig
from tests.analysis.test_map import FILES
from tests.analysis.test_map_golden import GOLDEN, snapshot

TAGS = {
    "app/api.py": [("async def post_order", (
        "# @telelog id=app.api::post_order role=main feature=Orders parent=- n=1\n"
        "# purpose: Take an order\n# in: body (request body)\n# out: order\n# db: -\n# algo: 1) create\n"))],
    "app/services.py": [("async def create_order", (
        "# @telelog id=app.services::create_order role=sub feature=Orders parent=app.api::post_order n=1\n"
        "# purpose: Build the order\n# in: body (step:post_order)\n# out: order\n"))],
    "app/utils.py": [("def norm", (
        "# @telelog id=app.utils::norm role=helper feature=Orders parent=app.services::create_order purpose: Trim\n"))],
}


@pytest.fixture
def project(tmp_path: Path) -> Path:
    for rel, src in FILES.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(src, encoding="utf-8")
    return tmp_path


def apply_tags(project: Path, only: set[str] | None = None) -> None:
    for rel, items in TAGS.items():
        p = project / rel
        lines = p.read_text(encoding="utf-8").splitlines(keepends=True)
        for head, block in items:
            if only is not None and block.split("::")[1].split()[0] not in only:
                continue
            i = next(n for n, line in enumerate(lines) if line.startswith(head))
            while i > 0 and lines[i - 1].startswith("@"):
                i -= 1  # a tag sits above the decorators
            lines.insert(i, block)
        p.write_text("".join(lines), encoding="utf-8")


def test_no_tags_means_golden_payload_and_no_new_keys(project: Path):
    a = Analysis(str(project))
    assert build_map(a, None, {}) == build_map(a)
    m = build_map(a, None, tagged_function_ids(read_tags(a)))
    assert "telelog" not in m and all("tag" not in f for f in m["functions"].values())
    assert snapshot(project) == GOLDEN.read_text(encoding="utf-8")


def test_tags_set_roles_and_pins_still_win(project: Path):
    apply_tags(project)
    a = Analysis(str(project))
    tags = tagged_function_ids(read_tags(a))
    f = build_map(a, None, tags)["functions"]
    assert f["app.utils:norm"]["role"] == "child" and f["app.utils:norm"]["reasons"][0] == "tagged helper (telelog)"
    assert f["app.services:create_order"]["role"] == "main"  # sub stays on the map
    assert f["app.api:post_order"]["tag"] == {"role": "main", "feature": "Orders", "purpose": "Take an order"}
    assert "tag" not in f["app.services:list_orders"]  # untagged neighbours keep the automatic classification
    pinned = build_map(a, {"app.utils:norm": "main"}, tags)["functions"]["app.utils:norm"]
    assert pinned["role"] == "main" and pinned["reasons"][0].startswith("pinned main")


def test_mixed_project_tagged_get_new_keys_untagged_keep_old_output(project: Path):
    plain = build_map(Analysis(str(project)))["functions"]
    apply_tags(project, only={"post_order"})
    a = Analysis(str(project))
    mixed = build_map(a, None, tagged_function_ids(read_tags(a)))["functions"]
    assert mixed["app.api:post_order"]["tag"]["feature"] == "Orders"
    for fid, before in plain.items():
        if fid == "app.api:post_order":
            continue
        after = {k: v for k, v in mixed[fid].items() if k not in ("line", "end_line")}  # lines shift with the comment
        assert after == {k: v for k, v in before.items() if k not in ("line", "end_line")}, fid


def test_telelog_payload_features_tree_status_and_untagged(project: Path):
    apply_tags(project)
    a = Analysis(str(project))
    verified = current_fingerprints(a)
    p = project / "app/utils.py"
    p.write_text(p.read_text().replace("str(x).strip()", "str(x).strip().lower()"))
    b = Analysis(str(project))
    t = tools.telelog_payload(b, read_tags(b), verified)
    assert [f["name"] for f in t["features"]] == ["Orders"]
    orders = t["features"][0]
    assert orders["mains"] == ["app.api:post_order"] and orders["functions"] == 3 and orders["endpoints"] == 1
    assert t["children"] == {"app.api:post_order": ["app.services:create_order"],
                             "app.services:create_order": ["app.utils:norm"]}
    assert t["functions"]["app.utils:norm"]["status"] == "stale"
    assert t["functions"]["app.api:post_order"]["status"] == "ok"
    assert t["functions"]["app.api:post_order"]["routes"] == ["POST /orders"]
    assert t["untagged"] == {"app.api": ["app.api:get_orders"], "app.services": ["app.services:list_orders"],
                             "app.utils": ["app.utils:_tiny"]}
    assert t["coverage"] == {"tagged": 3, "total": 6, "stale": 1, "invalid": 0}


def test_invalid_tag_status_and_unparented_ordering(project: Path):
    apply_tags(project)
    p = project / "app/services.py"
    p.write_text(p.read_text().replace("role=sub feature=Orders", "role=sub feature=Orders color=red"))
    a = Analysis(str(project))
    t = tools.telelog_payload(a, read_tags(a), {})
    assert t["functions"]["app.services:create_order"]["status"] == "invalid"


def test_viewer_map_adds_telelog_only_when_tags_exist(project: Path, tmp_path: Path):
    app = create_app(ExplorerConfig(project_path=str(project)), watch=False, cache_dir=tmp_path / ".cache",
                     analyze_on_start=False)
    with TestClient(app) as client:
        app.state.analysis_service.analysis = Analysis(str(project))
        assert "telelog" not in client.get("/viewer/map").json()
        apply_tags(project)
        m = client.get("/viewer/map").json()
        assert m["telelog"]["coverage"]["tagged"] == 3
        assert m["functions"]["app.utils:norm"]["role"] == "child"
        assert json.dumps(m)  # the payload is plain JSON


def test_payload_carries_module_signature_and_files_for_the_city_view(project: Path):
    apply_tags(project)
    a = Analysis(str(project))
    t = tools.telelog_payload(a, read_tags(a), {})
    fn = t["functions"]["app.services:create_order"]
    assert fn["module"] == "app.services" and fn["signature"] == "create_order(body)"
    assert t["files"]["app.api"] == "app/api.py" and set(t["files"]) == {"app.api", "app.services", "app.utils"}  # modules with functions only


def test_payload_carries_endpoint_details_and_the_app_entry_point(project: Path):
    apply_tags(project)
    a = Analysis(str(project))
    t = tools.telelog_payload(a, read_tags(a), {})
    ep = t["functions"]["app.api:post_order"]["endpoints"]
    assert [(e["method"], e["path"]) for e in ep] == [("POST", "/orders")]
    assert set(ep[0]) == {"id", "method", "path", "status_code", "response_model", "dependencies", "summary"}
    assert t["functions"]["app.services:create_order"]["endpoints"] == []  # not a handler
    assert [(e["id"], e["framework"], e["module"]) for e in t["entry_points"]] == [("app.main:app", "FastAPI", "app.main")]
    assert t["endpoint_count"] == 2


def test_payload_has_function_to_function_calls_for_every_tagged_function(project: Path):
    apply_tags(project)
    a = Analysis(str(project))
    t = tools.telelog_payload(a, read_tags(a), {})
    # post_order -> create_order -> norm, among tagged functions only (list_orders is untagged)
    assert t["calls"] == {
        "app.api:post_order": [{"to": "app.services:create_order", "n": 1, "edge": "await"}],
        "app.services:create_order": [{"to": "app.utils:norm", "n": 1, "edge": "call"}],
    }


def test_function_calls_counts_call_sites_and_ignores_self_and_untracked(tmp_path: Path):
    (tmp_path / "m.py").write_text(
        "def helper(x):\n    return x\n\n"
        "def other():\n    return 1\n\n"
        "def top(xs):\n    for x in xs:\n        helper(x)\n    helper(1)\n    top(xs)\n    other()\n    len(xs)\n",
        encoding="utf-8")
    a = Analysis(str(tmp_path))
    calls = tools.function_calls(a, ["m:top", "m:helper"])  # `other` is not asked about
    assert calls == {"m:top": [{"to": "m:helper", "n": 2, "edge": "call"}]}


def test_flow_steps_walk_the_call_tree_in_source_order_marking_repeats(project: Path):
    a = Analysis(str(project))
    f = tools.flow_steps(a, "app.api:post_order")
    assert f["route"] == "POST /orders" and f["handler"] == "app.api:post_order" and not f["truncated"]
    got = [(s["i"], s["kind"], s["id"], s["depth"], s["parent"], s["repeat"]) for s in f["steps"]]
    assert got == [
        (0, "fn", "app.api:post_order", 0, None, False),
        (1, "fn", "app.services:create_order", 1, 0, False),
        (2, "fn", "app.utils:norm", 2, 1, False),
        (3, "external", "httpx.AsyncClient", 2, 1, False),
        (4, "external", "httpx.AsyncClient().post", 2, 1, False),
        (5, "fn", "app.services:list_orders", 2, 1, False),
        (6, "fn", "app.utils:norm", 3, 5, True),  # reached again: listed, not expanded twice
        (7, "fn", "app.utils:_tiny", 3, 5, False),
    ]
    assert f["steps"][1]["edge"] == "await" and f["steps"][1]["line"] == 6  # the call site in the handler


def test_flow_steps_caps_the_walk_and_handles_unknown_ids(project: Path):
    a = Analysis(str(project))
    capped = tools.flow_steps(a, "app.api:post_order", max_steps=3)
    assert len(capped["steps"]) == 3 and capped["truncated"] is True
    assert tools.flow_steps(a, "nope:missing") is None
    # a function that is not an endpoint can be walked too
    assert [s["id"] for s in tools.flow_steps(a, "app.services:list_orders")["steps"]][:2] == ["app.services:list_orders", "app.utils:norm"]

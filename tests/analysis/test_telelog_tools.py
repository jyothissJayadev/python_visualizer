from __future__ import annotations

from pathlib import Path

import pytest

from backend.analysis.engine import Analysis
from backend.analysis.telelog import current_fingerprints, validate_tags
from backend.analysis.telelog_store import TelelogStore
from backend.analysis import telelog_tools as tools
from tests.analysis.test_map import FILES
from tests.analysis.test_telelog_store import tag


@pytest.fixture
def project(tmp_path: Path) -> Path:
    for rel, src in FILES.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(src, encoding="utf-8")
    return tmp_path


def test_get_function_fields_and_missing_id(project: Path):
    tag(project, "app/services.py", "async def create_order", "create_order")
    a = Analysis(str(project))
    got = tools.get_function(a, ["app.api:post_order", "app.services:create_order", "nope:x"])
    post, create, missing = got
    assert post["route"] == [{"method": "POST", "path": "/orders"}]
    assert post["source"]["start"] == 4  # includes the decorator line
    assert "@router.post" in post["source"]["text"] and post["source"]["truncated"] is False
    assert post["callees"] == ["app.services:create_order"] and post["tag"] is None
    assert create["tag"]["role"] == "helper" and create["tag"]["feature"] == "Orders"
    assert set(create["callees"]) == {"app.utils:norm", "app.services:list_orders"}
    assert create["callers"] == ["app.api:post_order"]
    assert post["nearby_features"] == ["Orders"]  # its callee is tagged
    assert len(create["fingerprint"]) == 16
    assert missing == {"id": "nope:x", "error": "not found"}


def test_get_function_caps_long_source(tmp_path: Path):
    body = "".join(f"    x{i} = {i}\n" for i in range(200))
    (tmp_path / "m.py").write_text("def big():\n" + body, encoding="utf-8")
    src = tools.get_function(Analysis(str(tmp_path)), ["m:big"])[0]["source"]
    assert src["truncated"] is True and len(src["text"].splitlines()) == tools.MAX_SOURCE_LINES


def test_feature_tree_groups_by_feature(project: Path):
    tag(project, "app/api.py", "async def post_order", "post_order")
    p = project / "app/services.py"
    p.write_text(p.read_text().replace(
        "async def create_order",
        "# @telelog id=app.services::create_order role=main feature=Billing parent=- n=1\n"
        "# purpose: Make it\n# in: b (query)\n# out: o\n# db: -\n# algo: 1) go\nasync def create_order"))
    from backend.analysis.telelog import read_tags
    tree = tools.feature_tree(read_tags(Analysis(str(project))))["features"]
    assert [(f["name"], f["functions"], [m["id"] for m in f["mains"]]) for f in tree] == [
        ("Billing", 1, ["app.services:create_order"]), ("Orders", 1, [])]
    assert tree[0]["mains"][0]["purpose"] == "Make it"


def test_suggest_parent_walks_up_through_untagged_callers(project: Path):
    tag(project, "app/api.py", "async def post_order", "post_order")
    a = Analysis(str(project))
    got = tools.suggest_parent(a, "app.utils:norm")
    assert [(g["id"], g["distance"]) for g in got] == [("app.api:post_order", 2)]  # norm -> create_order -> post_order
    tag(project, "app/services.py", "async def create_order", "create_order")
    got = tools.suggest_parent(a, "app.utils:norm")
    assert got[0] == {"id": "app.services:create_order", "role": "helper", "feature": "Orders", "distance": 1}
    assert tools.suggest_parent(a, "app.api:post_order") == []  # nothing calls a handler


def test_check_changed_reports_changed_tagged_and_untagged(project: Path):
    tag(project, "app/utils.py", "def norm", "norm")
    a = Analysis(str(project))
    verified = current_fingerprints(a)
    p = project / "app/utils.py"
    p.write_text(p.read_text().replace("str(x).strip()", "str(x).strip().lower()"))
    b = Analysis(str(project))
    r = tools.check_changed(b, ["app/utils.py"], verified)
    assert [c["id"] for c in r["changed"]] == ["app.utils:norm"] and r["untagged"] == ["app.utils:_tiny"]
    assert tools.check_changed(b, [str(project / "app/utils.py")], verified) == r  # absolute path works
    assert tools.check_changed(b, ["app/api.py"], verified)["changed"] == []  # other file untouched
    assert tools.check_changed(b, ["app/utils.py"], verified, exclude=lambda f: True) == {"changed": [], "untagged": []}
    assert tools.check_changed(b, ["elsewhere/other.py"], verified) == {"changed": [], "untagged": []}


def test_record_progress_verifies_only_tagged_ids(project: Path):
    tag(project, "app/utils.py", "def norm", "norm")
    a = Analysis(str(project))
    store = TelelogStore(project)
    r = tools.record_progress(a, store, ["app.utils:norm", "app.utils:_tiny"])
    assert r["verified"] == ["app.utils:norm"] and r["not_tagged"] == ["app.utils:_tiny"] and r["count"] == 2
    assert set(store.verified()) == {"app.utils:norm"}
    assert store.verified()["app.utils:norm"] == current_fingerprints(a)["app.utils:norm"]


def test_validation_summary_is_compact(project: Path):
    a = Analysis(str(project))
    s = tools.validation_summary(validate_tags(a))
    assert s["ok"] is False and s["by_code"] == {"missing-tag": 6} and s["functions"] == 6 and s["tagged"] == 0
    assert len(s["issues"]) == 6 and s["truncated"] is False
    assert tools.validate(a, TelelogStore(project))["errors"] == 6

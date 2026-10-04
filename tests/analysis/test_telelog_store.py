from __future__ import annotations

import threading
from pathlib import Path

import pytest

from backend.analysis.engine import Analysis
from backend.analysis.telelog_store import (
    TelelogConfig,
    TelelogStore,
    list_untagged,
    load_config,
)
from tests.analysis.test_map import FILES


@pytest.fixture
def project(tmp_path: Path) -> Path:
    for rel, src in FILES.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(src, encoding="utf-8")
    return tmp_path


def tag(project: Path, rel: str, func_line_start: str, fid_qual: str) -> None:
    """Insert a minimal helper tag directly above the line starting with `func_line_start`."""
    p = project / rel
    lines = p.read_text(encoding="utf-8").splitlines(keepends=True)
    i = next(n for n, line in enumerate(lines) if line.startswith(func_line_start))
    while i > 0 and lines[i - 1].startswith("@"):
        i -= 1  # above decorators
    module = rel[:-3].replace("/", ".")
    lines.insert(i, f"# @telelog id={module}::{fid_qual} role=helper feature=Orders parent=- purpose: x\n")
    p.write_text("".join(lines), encoding="utf-8")


# ── config ───────────────────────────────────────────────────────────────────

def test_default_excludes_tests_migrations_generated():
    c = TelelogConfig()
    for path in ("tests/test_a.py", "app/tests/helpers.py", "test_x.py", "app/test_x.py", "x_test.py", "conftest.py",
                 "app/migrations/0001_init.py", "alembic/versions/ab12.py", "api/x_pb2.py"):
        assert c.is_excluded(path), path
    for path in ("app/services.py", "app/testing_utils.py", "app/contests.py"):
        assert not c.is_excluded(path), path


def test_config_file_adds_excludes_and_can_drop_defaults(tmp_path: Path):
    assert load_config(tmp_path).is_excluded("tests/a.py")  # no file: defaults only
    (tmp_path / ".telelog").mkdir()
    (tmp_path / ".telelog" / "config").write_text(
        "# comment\nexclude: scripts/**\nexclude: **/legacy_*.py  # trailing\nnonsense\n", encoding="utf-8")
    c = load_config(tmp_path)
    assert c.is_excluded("scripts/run.py") and c.is_excluded("app/legacy_x.py") and c.is_excluded("tests/a.py")
    (tmp_path / ".telelog" / "config").write_text("defaults: off\nexclude: scripts/**\n", encoding="utf-8")
    c = load_config(tmp_path)
    assert c.is_excluded("scripts/run.py") and not c.is_excluded("tests/a.py")


# ── store ────────────────────────────────────────────────────────────────────

def test_verified_and_progress_round_trip(tmp_path: Path):
    s = TelelogStore(tmp_path)
    assert s.verified() == {} and s.get_progress()["count"] == 0
    s.mark_verified({"a:f": "h1", "a:g": "h2"})
    s.mark_verified({"a:g": "h3"})
    assert TelelogStore(tmp_path).verified() == {"a:f": "h1", "a:g": "h3"}  # a fresh store sees it
    s.forget_verified(["a:f", "missing"])
    assert s.verified() == {"a:g": "h3"}
    s.record_progress(["x", "y"])
    p = s.record_progress(["y", "z"])
    assert p["done"] == ["x", "y", "z"] and p["count"] == 3 and p["updated"]
    s.reset_progress()
    assert s.get_progress()["count"] == 0
    assert not list((tmp_path / ".telelog" / "state").glob("*.tmp"))  # atomic write leaves no temp file


def test_corrupt_and_foreign_version_files_read_as_empty(tmp_path: Path):
    s = TelelogStore(tmp_path)
    s.mark_verified({"a:f": "h"})
    f = tmp_path / ".telelog" / "state" / "verified.json"
    f.write_text("{not json", encoding="utf-8")
    assert s.verified() == {}
    f.write_text('{"version": 99, "hashes": {"a:f": "h"}}', encoding="utf-8")
    assert s.verified() == {}
    s.mark_verified({"a:g": "h"})  # recovers by overwriting
    assert s.verified() == {"a:g": "h"}


def test_concurrent_progress_writes_never_drop_one(tmp_path: Path):
    s = TelelogStore(tmp_path)
    ids = [f"m:f{i}" for i in range(40)]
    threads = [threading.Thread(target=lambda i=i: TelelogStore(tmp_path).record_progress([i])) for i in ids]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert s.get_progress()["done"] == sorted(ids)


# ── list_untagged ────────────────────────────────────────────────────────────

def test_order_endpoints_then_callees_then_rest_with_hints(project: Path):
    r = list_untagged(Analysis(str(project)), limit=50)
    ids = [i["id"] for i in r["items"]]
    assert ids[:2] == ["app.api:get_orders", "app.api:post_order"]
    assert set(ids[2:4]) == {"app.services:create_order", "app.services:list_orders"}
    assert set(ids[4:]) == {"app.utils:norm", "app.utils:_tiny"}
    by_id = {i["id"]: i for i in r["items"]}
    assert "endpoint" in by_id["app.api:post_order"]["hints"]
    assert "db-touching" not in by_id["app.services:create_order"]["hints"]  # http call, not a db
    assert r["next_cursor"] is None and r["total_untagged"] == len(ids)


def test_cursor_is_stable_while_the_agent_tags(project: Path):
    a = Analysis(str(project))
    first = list_untagged(a, limit=2)
    assert [i["id"] for i in first["items"]] == ["app.api:get_orders", "app.api:post_order"]
    tag(project, "app/api.py", "async def post_order", "post_order")  # tagged between pages
    tag(project, "app/api.py", "async def get_orders", "get_orders")
    second = list_untagged(a, limit=2, cursor=first["next_cursor"])
    assert {i["id"] for i in second["items"]} == {"app.services:create_order", "app.services:list_orders"}
    third = list_untagged(a, limit=2, cursor=second["next_cursor"])
    assert {i["id"] for i in third["items"]} == {"app.utils:norm", "app.utils:_tiny"} and third["next_cursor"] is None
    assert list_untagged(a, limit=50)["total_untagged"] == 4  # the tagged two are gone


def test_exclude_and_feature_filter(project: Path):
    a = Analysis(str(project))
    r = list_untagged(a, limit=50, exclude=lambda f: f.module == "app.utils")
    assert all(not i["id"].startswith("app.utils") for i in r["items"])
    assert list_untagged(a, limit=50, feature="Orders")["items"] == []  # nothing tagged yet
    tag(project, "app/services.py", "async def create_order", "create_order")
    near = {i["id"] for i in list_untagged(a, limit=50, feature="Orders")["items"]}
    assert near == {"app.api:post_order", "app.utils:norm", "app.services:list_orders"}  # callers/callees of it
    assert list_untagged(a, limit=50, feature="Other")["items"] == []


def test_bad_cursor_and_tiny_limit_do_not_crash(project: Path):
    a = Analysis(str(project))
    assert len(list_untagged(a, limit=0)["items"]) == 1
    assert len(list_untagged(a, limit=50, cursor="garbage")["items"]) == 6

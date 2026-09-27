"""tests/analysis/test_templates.py — backend/analysis/templates.py: the
Trace Templates JSON store shared by the REST endpoints (backend/api/viewer.py)
and the MCP tools (backend/mcp_server.py)."""

from __future__ import annotations

import asyncio

import pytest

from backend.analysis.templates import TemplateStore, TemplateValidationError

PROJECT = "/tmp/some-project"


def make_store(tmp_path) -> TemplateStore:
    return TemplateStore(PROJECT, tmp_path / "cache")


@pytest.mark.asyncio
async def test_create_persists_and_reloads_across_a_fresh_instance(tmp_path):
    store = make_store(tmp_path)
    template = await store.create("checkout", [{"id": "app.checkout:process_order", "deep": True}])
    assert template["name"] == "checkout"
    assert template["functions"] == [{"id": "app.checkout:process_order", "deep": True}]
    assert template["id"].startswith("tpl_")

    # a brand-new instance for the same project/cache_dir must see it on disk
    reloaded = make_store(tmp_path)
    assert [t["name"] for t in reloaded.list_raw()] == ["checkout"]


@pytest.mark.asyncio
async def test_create_rejects_empty_name_and_empty_functions(tmp_path):
    store = make_store(tmp_path)
    with pytest.raises(TemplateValidationError):
        await store.create("   ", [{"id": "a:b", "deep": False}])
    with pytest.raises(TemplateValidationError):
        await store.create("name", [])
    with pytest.raises(TemplateValidationError):
        await store.create("name", [{"id": "  ", "deep": False}])


@pytest.mark.asyncio
async def test_create_rejects_duplicate_name_case_insensitively(tmp_path):
    store = make_store(tmp_path)
    await store.create("Checkout", [{"id": "a:b", "deep": False}])
    with pytest.raises(TemplateValidationError):
        await store.create("checkout", [{"id": "c:d", "deep": False}])


@pytest.mark.asyncio
async def test_update_rename_to_own_current_name_is_not_a_duplicate(tmp_path):
    store = make_store(tmp_path)
    t = await store.create("Checkout", [{"id": "a:b", "deep": False}])
    updated = await store.update(t["id"], name="checkout")  # case-only correction of itself
    assert updated["name"] == "checkout"


@pytest.mark.asyncio
async def test_update_partial_fields_leave_the_other_untouched(tmp_path):
    store = make_store(tmp_path)
    t = await store.create("checkout", [{"id": "a:b", "deep": False}])
    renamed = await store.update(t["id"], name="checkout flow")
    assert renamed["functions"] == [{"id": "a:b", "deep": False}]

    replaced = await store.update(t["id"], functions=[{"id": "c:d", "deep": True}])
    assert replaced["name"] == "checkout flow"
    assert replaced["functions"] == [{"id": "c:d", "deep": True}]


@pytest.mark.asyncio
async def test_update_missing_template_raises_keyerror(tmp_path):
    store = make_store(tmp_path)
    with pytest.raises(KeyError):
        await store.update("tpl_missing", name="x")


@pytest.mark.asyncio
async def test_delete_returns_false_for_unknown_id(tmp_path):
    store = make_store(tmp_path)
    assert await store.delete("tpl_missing") is False
    t = await store.create("checkout", [{"id": "a:b", "deep": False}])
    assert await store.delete(t["id"]) is True
    assert store.list_raw() == []


def test_list_annotated_flags_missing_and_suggests_renames(tmp_path):
    store = make_store(tmp_path)
    asyncio.run(store.create("checkout", [{"id": "app.checkout:process_order", "deep": True}]))

    annotated = store.list_annotated({"app.checkout:process_order_v2"})
    fn = annotated[0]["functions"][0]
    assert fn["status"] == "missing"
    assert "app.checkout:process_order_v2" in fn["suggestions"]

    ok = store.list_annotated({"app.checkout:process_order"})
    assert ok[0]["functions"][0]["status"] == "ok"
    assert ok[0]["functions"][0]["suggestions"] == []


def test_list_annotated_before_first_scan_is_unknown_not_missing(tmp_path):
    store = make_store(tmp_path)
    asyncio.run(store.create("checkout", [{"id": "a:b", "deep": False}]))
    # catalog_ids=None means "not scanned yet" — must never render as a false
    # missing badge before the AST scanner has run once.
    annotated = store.list_annotated(None)
    assert annotated[0]["functions"][0]["status"] == "unknown"


def test_list_annotated_never_mutates_stored_functions(tmp_path):
    """Annotation is display-only — apply() must always see the plain,
    unannotated {id, deep} shape, never a status/suggestions field leaking in."""
    store = make_store(tmp_path)
    asyncio.run(store.create("checkout", [{"id": "a:b", "deep": False}]))
    store.list_annotated({"a:b"})
    assert store.list_raw()[0]["functions"] == [{"id": "a:b", "deep": False}]


@pytest.mark.asyncio
async def test_concurrent_writes_do_not_drop_each_other(tmp_path):
    """Regression test for the office-hours review finding: a UI edit and a
    concurrent MCP save_template on the same project must not race and
    silently lose one write."""
    store = make_store(tmp_path)

    async def create_one(n: int):
        await store.create(f"template-{n}", [{"id": f"m:{n}", "deep": False}])

    await asyncio.gather(*(create_one(n) for n in range(10)))

    names = {t["name"] for t in store.list_raw()}
    assert names == {f"template-{n}" for n in range(10)}

    reloaded = make_store(tmp_path)
    assert {t["name"] for t in reloaded.list_raw()} == names

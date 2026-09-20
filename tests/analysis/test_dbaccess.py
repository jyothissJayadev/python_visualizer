from __future__ import annotations

from pathlib import Path

from backend.analysis.callgraph import render
from backend.analysis.engine import Analysis
from backend.analysis.funcview import data_summary, function_view

FILES = {
    "app/__init__.py": "",
    # the shared factory: collection("quotation", "rows") -> db()["quotation_rows"]
    "app/mongo.py": (
        "def db(): ...\n"
        "def collection(domain, name):\n"
        "    return wrap(db()[f\"{domain}_{name}\"])\n"
        "def wrap(c): return c\n"
    ),
    "app/models.py": (
        "from beanie import Document\n"
        "class Session(Document):\n"
        "    class Settings:\n"
        "        name = 'sessions'\n"
        "class Sub(Session):\n"
        "    pass\n"
    ),
    "app/store.py": (
        "from app.mongo import collection\n"
        "from app.models import Session, Sub\n"
        "def _rows():\n"
        "    return collection('quotation', 'rows')\n"
        "def _other():\n"
        "    return _rows()\n"                       # a helper returning another helper
        "async def get_row(i):\n"
        "    return await _rows().find_one({'i': i})\n"
        "async def list_rows():\n"
        "    return await _rows().find({}).sort('i').to_list(10)\n"
        "async def save_row(r):\n"
        "    await _rows().update_one({'i': r}, {'$set': r}, upsert=True)\n"
        "    await _other().insert_one(r)\n"
        "async def drop_row(i):\n"
        "    coll = collection('quotation', 'rows')\n"
        "    await coll.delete_one({'i': i})\n"
        "async def dynamic(name):\n"
        "    await collection('quotation', name).find_one({})\n"          # name unknown -> not a table
        "async def touch_session(sid):\n"
        "    s = await Session.find_one(Session.id == sid)\n"
        "    await s.save()\n"
        "    await Sub.delete_all()\n"
    ),
    "app/graph.py": (
        "def link(session):\n"
        "    '''MATCH (x:Docstring) is documentation, not a query'''\n"
        "    session.run('MATCH (c:Concept)-[:HAS]->(e:Entity) WHERE c.id = $id RETURN e')\n"
        "    session.run('MERGE (k:KNode {id: $id}) SET k.v = 1')\n"
        "def helper(session):\n"
        "    def inner():\n"
        "        return 'MATCH (n:InsideNested) RETURN n'\n"
        "    return inner\n"
    ),
    "app/main.py": (
        "from fastapi import FastAPI\n"
        "from app import store, graph\n"
        "app = FastAPI()\n"
        "@app.post('/x')\n"
        "async def x(session=None):\n"
        "    await store.get_row(1)\n"
        "    await store.list_rows()\n"
        "    await store.save_row({})\n"
        "    await store.drop_row(1)\n"
        "    await store.dynamic('n')\n"
        "    await store.touch_session('s')\n"
        "    graph.link(session)\n"
    ),
}


def _view(tmp_path: Path):
    for rel, src in FILES.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(src, encoding="utf-8")
    a = Analysis(str(tmp_path))
    return a, function_view(a.callgraph.endpoint_root(a.endpoint("POST /x")))


def _data_of(view, name):
    node = next(c for c in view.children if c.name == name)
    return {(e["table"], e["op"]) for e in node.meta.get("data", [])}


def test_collection_handles_are_followed_through_helper_functions(tmp_path: Path):
    _, view = _view(tmp_path)
    t = "mongo:quotation_rows"
    assert _data_of(view, "get_row") == {(t, "read")}
    assert _data_of(view, "list_rows") == {(t, "read")}           # .sort().to_list() chaining is not noise-reported
    assert _data_of(view, "save_row") == {(t, "upsert"), (t, "write")}  # upsert=True is recognised; helper-of-helper works
    assert _data_of(view, "drop_row") == {(t, "delete")}          # local variable holding the handle
    # a dynamic collection name is not guessed into a table — it is flagged as an unattributed DB call
    assert _data_of(view, "dynamic") == {("?", "read")}


def test_beanie_documents_including_subclasses(tmp_path: Path):
    _, view = _view(tmp_path)
    got = _data_of(view, "touch_session")
    assert ("mongo:Session", "read") in got and ("mongo:Session", "write") in got  # find_one / save
    assert ("mongo:Sub", "delete") in got                                          # inherited Document


def test_cypher_labels_come_from_query_strings_not_docstrings_or_nested_functions(tmp_path: Path):
    _, view = _view(tmp_path)
    got = _data_of(view, "link")
    assert got == {
        ("neo4j:Concept", "read"), ("neo4j:Entity", "read"), ("neo4j-rel:HAS", "read"), ("neo4j:KNode", "write"),
    }


def test_data_summary_lists_tables_with_operations_and_function_paths(tmp_path: Path):
    _, view = _view(tmp_path)
    tables = {t["table"]: t for t in data_summary(view)["tables"]}
    rows = tables["mongo:quotation_rows"]
    assert rows["database"] == "mongodb" and rows["name"] == "quotation_rows"
    assert rows["ops"] == {"read": 2, "upsert": 1, "write": 1, "delete": 1}
    assert {f["name"] for f in rows["functions"]} == {"get_row", "list_rows", "save_row", "drop_row"}
    assert all(f["path"].startswith("0.") for f in rows["functions"])
    assert tables["neo4j:KNode"]["database"] == "neo4j"
    assert not any(t.endswith(("None", "quotation_")) for t in tables)  # the dynamic collection name was not guessed


def test_db_nodes_are_not_library_calls_and_payload_carries_data(tmp_path: Path):
    _, view = _view(tmp_path)
    tree = render(view, "0", None, "0")
    get_row = next(c for c in tree["children"] if c["name"] == "get_row")
    assert get_row["meta"]["data"] == [{"table": "mongo:quotation_rows", "op": "read", "count": 1}]
    assert "library_count" not in get_row.get("meta", {})  # find_one was not reported as an unresolved call

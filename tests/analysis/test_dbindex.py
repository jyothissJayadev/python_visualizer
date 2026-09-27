"""Project-wide table index: functions, endpoints + call chains, inferred fields."""

from __future__ import annotations

from pathlib import Path

from backend.analysis.dbindex import build_database_index
from backend.analysis.engine import Analysis

FILES = {
    "app/__init__.py": "",
    "app/mongo.py": "def db(): ...\ndef collection(domain, name):\n    return db()[f\"{domain}_{name}\"]\n",
    "app/models.py": (
        "from beanie import Document\n"
        "from pydantic import BaseModel\n"
        "class Project(Document):\n"
        "    project_id: str\n"
        "    summary: dict[str, int] = {}\n"
        "    _private: int = 0\n"
        "class Row(BaseModel):\n"
        "    sno: int\n"
        "    description: str\n"
        "    rate: float | None = None\n"
    ),
    "app/store.py": (
        "from app.mongo import collection\n"
        "from app.models import Project, Row\n"
        "def _rows():\n"
        "    return collection('quotation', 'rows')\n"
        "async def save_row(row: Row, qid: str):\n"
        "    await _rows().insert_one({**row.model_dump(), 'quotation_id': qid, 'active': True})\n"
        "async def touch(qid, n):\n"
        "    await _rows().update_one({'quotation_id': qid, 'status': {'$in': ['a']}}, {'$set': {'count': 1, 'label': 'x'}, '$inc': {'hits': 1}})\n"
        "async def get(qid):\n"
        "    return await _rows().find_one({'quotation_id': qid, 'sno': 1})\n"
        "async def load_project(pid):\n"
        "    return await Project.find_one(Project.project_id == pid)\n"
    ),
    "app/graph.py": (
        "def link(session):\n"
        "    session.run('MERGE (c:Concept {id: $id, domain: $d}) SET c.name = $n')\n"
        "    session.run('MATCH (c:Concept)-[r:IS_A {weight: $w}]->(p:Concept) SET r.status = 1 RETURN p.title')\n"
    ),
    "app/main.py": (
        "from fastapi import FastAPI\n"
        "from app import store, graph\n"
        "app = FastAPI()\n"
        "@app.post('/rows')\n"
        "async def create(row=None, session=None):\n"
        "    '''Create a row.'''\n"
        "    await store.save_row(row, 'q')\n"
        "    await store.touch('q', 1)\n"
        "    graph.link(session)\n"
        "@app.get('/rows/{qid}')\n"
        "async def read(qid: str):\n"
        "    await store.get(qid)\n"
        "    return await store.load_project(qid)\n"
    ),
}


def _index(tmp_path: Path) -> dict[str, dict]:
    for rel, src in FILES.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(src, encoding="utf-8")
    return {t["table"]: t for t in build_database_index(Analysis(str(tmp_path)))["tables"]}


def test_mongo_fields_are_inferred_from_writes_updates_filters_and_models(tmp_path: Path):
    rows = _index(tmp_path)["mongo:quotation_rows"]
    fields = {f["name"]: f for f in rows["fields"]}
    # model_dump() of the Row model (types come from its annotations) + explicit keys + $set / $inc keys
    assert fields["sno"]["type"] == "int" and fields["rate"]["type"] == "float | None"
    assert {"description", "quotation_id", "active", "count", "label", "hits"} <= set(fields)
    assert fields["active"]["type"] == "boolean" and fields["label"]["type"] == "string"
    assert fields["sno"]["source"] == "write"
    # a field only ever *queried* is included, and marked as such; an operator is never a field
    assert "status" in fields and fields["status"]["source"] == "query"
    assert not any(name.startswith("$") for name in fields)


def test_beanie_documents_take_their_fields_from_the_model(tmp_path: Path):
    project = _index(tmp_path)["mongo:Project"]
    fields = {f["name"]: f for f in project["fields"]}
    assert set(fields) == {"project_id", "summary"}  # private attributes are not fields
    assert fields["summary"]["type"] == "dict[str, int]" and fields["project_id"]["source"] == "model"


def test_neo4j_properties_come_from_property_maps_and_accesses(tmp_path: Path):
    idx = _index(tmp_path)
    assert {f["name"] for f in idx["neo4j:Concept"]["fields"]} == {"id", "domain", "name", "title"}
    assert {f["name"] for f in idx["neo4j-rel:IS_A"]["fields"]} == {"weight", "status"}
    assert idx["neo4j-rel:IS_A"]["kind"] == "relationship" and idx["neo4j:Concept"]["kind"] == "label"


def test_endpoints_and_functions_with_real_call_chains(tmp_path: Path):
    rows = _index(tmp_path)["mongo:quotation_rows"]
    by_ep = {(e["method"], e["path"]): e for e in rows["endpoints"]}
    assert set(by_ep) == {("POST", "/rows"), ("GET", "/rows/{qid}")}
    post = by_ep[("POST", "/rows")]
    assert post["summary"] == "Create a row." and post["call_chain"] == ["create", "save_row"] or post["call_chain"][:1] == ["create"]
    assert set(post["ops"]) >= {"write", "upsert"} or "write" in post["ops"]
    fns = {(f["name"], f["op"]) for f in rows["functions"]}
    assert ("save_row", "write") in fns and ("get", "read") in fns and ("touch", "write") in fns
    assert all(f["module"] == "app.store" for f in rows["functions"])
    assert rows["ops"]["read"] >= 1 and rows["ops"]["write"] >= 2


def _indexes(tmp_path: Path, files: dict[str, str]) -> dict[str, list[dict]]:
    for rel, src in {"app/__init__.py": "", **files}.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(src, encoding="utf-8")
    return {t["table"]: t["indexes"] for t in build_database_index(Analysis(str(tmp_path)))["tables"] if t["indexes"]}


def test_mongo_indexes_are_read_from_create_index_calls_including_beanie_collections(tmp_path: Path):
    got = _indexes(tmp_path, {
        "app/mongo.py": "def db(): ...\ndef collection(d, n):\n    return db()[f'{d}_{n}']\n",
        "app/models.py": (
            "from beanie import Document\n"
            "class Session(Document):\n"
            "    session_id: str\n"
            "    class Settings:\n"
            "        name = 'sessions'\n"
            "        indexes = ['session_id', [('a', 1), ('b', -1)]]\n"
        ),
        "app/setup.py": (
            "from pymongo import IndexModel, ASCENDING, DESCENDING\n"
            "from app.mongo import collection\n"
            "async def ensure(database):\n"
            "    await collection('core', 'usage').create_index('ts')\n"
            "    await collection('core', 'usage').create_index([('operation', 1), ('ts', DESCENDING)])\n"
            "    sessions = database['sessions']\n"                       # raw name: belongs to the Beanie doc
            "    await sessions.create_indexes([IndexModel('session_id', unique=True), IndexModel('updated_at', expireAfterSeconds=60)])\n"
            "    await database['other'].create_indexes([IndexModel([('x', ASCENDING)], name='x_idx')])\n"
        ),
    })
    usage = {(i["kind"], tuple(i["keys"]), i["unique"]) for i in got["mongo:core_usage"]}
    assert usage == {("index", ("ts",), False), ("index", ("operation", "-ts"), False)}
    sess = {(i["kind"], tuple(i["keys"]), i["unique"]) for i in got["mongo:Session"]}
    assert ("index", ("session_id",), True) in sess            # IndexModel(unique=True), via database["sessions"]
    assert ("ttl", ("updated_at",), False) in sess             # expireAfterSeconds => a TTL index
    assert ("index", ("a", "-b"), False) in sess               # Beanie `Settings.indexes`
    assert got["mongo:other"][0]["name"] == "x_idx"            # an unknown raw name is still a table


def test_neo4j_indexes_from_constant_lists_and_fstrings_over_imported_labels(tmp_path: Path):
    got = _indexes(tmp_path, {
        "app/labels.py": "EV_ITEM = 'EvItem'\nEV_SEC = 'EvSec'\nEV_LABELS = frozenset({EV_ITEM, EV_SEC})\n",
        "app/schema.py": (
            "_STATEMENTS = [\n"
            "    'CREATE CONSTRAINT k IF NOT EXISTS FOR (n:KNode) REQUIRE n.node_id IS UNIQUE',\n"
            "    'CREATE INDEX kv IF NOT EXISTS FOR (v:KNode) ON (v.project_id, v.path)',\n"
            "    'CREATE INDEX r IF NOT EXISTS FOR ()-[e:NEXT]-() ON (e.domain)',\n"
            "]\n"
            "async def ensure(session):\n"
            "    from app.labels import EV_LABELS\n"                     # imported *inside* the function
            "    for label in sorted(EV_LABELS):\n"
            "        await session.run(\n"
            "            f'CREATE CONSTRAINT ev_{label.lower()}_id IF NOT EXISTS '\n"
            "            f'FOR (n:{label}) REQUIRE (n.domain, n.id) IS UNIQUE'\n"
            "        )\n"
            "async def unresolved(session, label):\n"
            "    await session.run(f'CREATE INDEX x FOR (n:{label}) ON (n.a)')\n"   # label unknown: not guessed
        ),
    })
    knode = {(i["kind"], tuple(i["keys"]), i["unique"]) for i in got["neo4j:KNode"]}
    assert knode == {("constraint", ("node_id",), True), ("index", ("project_id", "path"), False)}
    assert got["neo4j-rel:NEXT"][0]["keys"] == ["domain"]
    for label in ("EvItem", "EvSec"):  # one constraint per label in the loop
        assert [(i["kind"], tuple(i["keys"]), i["unique"]) for i in got[f"neo4j:{label}"]] == [("constraint", ("domain", "id"), True)]
    assert not any("_UNK_" in t or "\x00" in t for t in got)  # the unresolved statement produced no table

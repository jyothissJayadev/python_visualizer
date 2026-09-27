"""Connections between tables: exact Neo4j edges, inferred Mongo references."""

from __future__ import annotations

from pathlib import Path

from backend.analysis.dbindex import build_database_index
from backend.analysis.engine import Analysis
from backend.analysis.relations import entity_aliases, mongo_references


def _table(table: str, fields: list[str] = (), database: str = "mongodb", kind: str = "collection") -> dict:
    return {"table": table, "database": database, "kind": kind, "name": table.split(":", 1)[1],
            "fields": [{"name": f, "type": "any", "source": "write"} for f in fields]}


def test_entity_aliases_from_table_names():
    assert entity_aliases(_table("mongo:quotation_quotations")) == {"quotation": 0}
    assert entity_aliases(_table("mongo:quotation_sections"))["section"] == 0
    assert entity_aliases(_table("mongo:execution_ext_plans"))["plan"] == 0  # the `ext_` prefix is noise
    assert entity_aliases(_table("mongo:ChatSession")) == {"chat_session": 0, "session": 1, "chat": 2}
    assert entity_aliases(_table("neo4j:KNode", database="neo4j", kind="label"))["node"] == 1


def test_references_follow_id_fields_to_exactly_one_table():
    tables = [
        _table("mongo:quotation_quotations", ["quotation_id"]),
        _table("mongo:quotation_sections", ["quotation_id", "section_id"]),
        _table("mongo:quotation_rows", ["quotation_id", "section_id", "winner_node_id"]),
        _table("neo4j:KNode", database="neo4j", kind="label"),
    ]
    rels = {(r["from"], r["to"]): r for r in mongo_references(tables)}
    assert ("mongo:quotation_sections", "mongo:quotation_quotations") in rels
    assert ("mongo:quotation_rows", "mongo:quotation_sections") in rels
    assert rels[("mongo:quotation_rows", "mongo:quotation_sections")]["label"] == "section_id"
    # a prefixed field (`winner_node_id`) still finds the entity it names, across databases
    cross = rels[("mongo:quotation_rows", "neo4j:KNode")]
    assert cross["type"] == "cross_database" and cross["confidence"] == "inferred"
    # a table's own key is not a reference to itself
    assert ("mongo:quotation_quotations", "mongo:quotation_quotations") not in rels


def test_an_ambiguous_reference_is_dropped_not_guessed():
    # two tables in the source's own domain both hold "items": no way to tell which is meant
    tables = [
        _table("mongo:quotation_rows", ["item_id"]),
        _table("mongo:quotation_items", ["item_id"]),
        _table("mongo:quotation_item", ["item_id"]),
    ]
    assert [r for r in mongo_references(tables) if r["from"] == "mongo:quotation_rows"] == []


def test_a_tie_between_domains_is_broken_by_the_sources_domain():
    tables = [
        _table("mongo:quotation_rows", ["item_id"]),
        _table("mongo:quotation_items", ["item_id"]),
        _table("mongo:execution_items", ["item_id"]),
    ]
    got = [(r["from"], r["to"]) for r in mongo_references(tables) if r["from"] == "mongo:quotation_rows"]
    assert got == [("mongo:quotation_rows", "mongo:quotation_items")]


def test_neo4j_edges_are_exact_directed_and_use_one_label_value_per_query(tmp_path: Path):
    files = {
        "app/__init__.py": "",
        "app/client.py": (
            "_BY = {'quotation': 'Concept', 'execution': 'Entity'}\n"
            "class Client:\n"
            "    def __init__(self, domain):\n"
            "        self.label = _BY.get(domain, 'Entity')\n"
            "    async def link(self, session):\n"
            "        await session.run(f'MATCH (a:{self.label})-[r:IS_A]->(b:{self.label}) RETURN r')\n"
            "    async def back(self, session):\n"
            "        await session.run('MATCH (p:Context)<-[:CHILD_OF]-(c:KNode) RETURN p')\n"
            "    async def merge(self, session):\n"
            "        await session.run('MATCH (x:KNode {id:$a}) MATCH (y:KNode {id:$b}) MERGE (x)-[r:REL]->(y)')\n"
            "def make(d) -> Client:\n"
            "    return Client(d)\n"
        ),
        "app/main.py": (
            "from fastapi import FastAPI\nfrom app.client import make\napp = FastAPI()\n"
            "@app.post('/x')\nasync def x(session=None):\n"
            "    c = make('quotation')\n    await c.link(session)\n    await c.back(session)\n    await c.merge(session)\n"
        ),
    }
    for rel, src in files.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(src, encoding="utf-8")
    rels = {(r["from"], r["label"], r["to"]): r for r in build_database_index(Analysis(str(tmp_path)))["relationships"]}
    # both ends of one query use the same {self.label}: Concept->Concept or Entity->Entity, never Concept->Entity
    assert ("neo4j:Concept", "IS_A", "neo4j:Concept") in rels and ("neo4j:Entity", "IS_A", "neo4j:Entity") in rels
    assert ("neo4j:Concept", "IS_A", "neo4j:Entity") not in rels
    assert rels[("neo4j:Concept", "IS_A", "neo4j:Concept")]["uncertain"] is True
    # `<-` reverses the direction: (Context)<-[:CHILD_OF]-(KNode) is KNode -> Context
    assert ("neo4j:KNode", "CHILD_OF", "neo4j:Context") in rels
    assert rels[("neo4j:KNode", "CHILD_OF", "neo4j:Context")]["uncertain"] is False
    # a bare-variable edge takes the labels those variables were bound to earlier in the query
    assert ("neo4j:KNode", "REL", "neo4j:KNode") in rels
    assert all(r["confidence"] == "exact" for r in rels.values() if r["type"] == "neo4j_edge")

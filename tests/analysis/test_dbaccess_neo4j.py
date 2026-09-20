"""Dynamic Neo4j labels / relationship types, and the coverage audit."""

from __future__ import annotations

from pathlib import Path

from backend.analysis.engine import Analysis
from backend.analysis.funcview import data_summary, function_view

FILES = {
    "app/__init__.py": "",
    "app/client.py": (
        "_LABEL_BY_DOMAIN = {'quotation': 'Concept', 'execution': 'Entity'}\n"
        "_DEFAULT = 'Entity'\n"
        "class GraphClient:\n"
        "    def __init__(self, domain):\n"
        "        self.domain = domain\n"
        "        self.label = _LABEL_BY_DOMAIN.get(domain, _DEFAULT)\n"
        "    async def _run(self, query):\n"                       # generic executor: the query arrives as a parameter
        "        async with self.driver.session() as session:\n"
        "            return await session.run(query)\n"
        "    async def get_node(self, node_id):\n"
        "        return await self._run(f'MATCH (n:{self.label} {{id: $id}}) RETURN n')\n"
        "    async def link(self, rel):\n"
        "        return await self._run(f'MATCH (a:{self.label})-[r:{rel}]->(b:{self.label}) RETURN r')\n"
        "    async def wipe(self):\n"
        "        return await self._run('MATCH (n:Context) DETACH DELETE n')\n"
        "    async def raw(self, session, cypher_text):\n"           # runs a query it did not build, has no `query` param
        "        return await session.run(cypher_text)\n"
        "def make():\n"
        "    return GraphClient('quotation')\n"
    ),
    "app/service.py": (
        "from app.client import make\n"
        "async def read_one(i):\n"
        "    return await make().get_node(i)\n"
        "async def read_isa():\n"
        "    return await make().link('IS_A')\n"                    # literal argument -> exact edge type
        "async def read_any(rel):\n"
        "    return await make().link(rel)\n"                       # not a literal -> cannot be named
        "async def wipe_it():\n"
        "    return await make().wipe()\n"
    ),
    "app/main.py": (
        "from fastapi import FastAPI\n"
        "from app import service\n"
        "app = FastAPI()\n"
        "@app.post('/x')\n"
        "async def x(rel: str = 'r'):\n"
        "    await service.read_one(1)\n"
        "    await service.read_isa()\n"
        "    await service.read_any(rel)\n"
        "    await service.wipe_it()\n"
    ),
}


def _view(tmp_path: Path):
    for rel, src in FILES.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(src, encoding="utf-8")
    a = Analysis(str(tmp_path))
    return function_view(a.callgraph.endpoint_root(a.endpoint("POST /x")))


def _walk(n):
    yield n
    for c in n.children:
        yield from _walk(c)


def _named(view, name):
    """Nodes for a function or method (methods are named `Class.method`)."""
    return [n for n in _walk(view) if n.name == name or n.name.endswith("." + name)]


def _entries(view, name):
    node = _named(view, name)[0]
    return {(e["table"], e["op"], bool(e.get("uncertain")), bool(e.get("unattributed"))) for e in node.meta.get("data", [])}


def test_label_from_a_class_attribute_and_dict_is_listed_as_one_of(tmp_path: Path):
    view = _view(tmp_path)
    # self.label = _LABEL_BY_DOMAIN.get(domain, "Entity") -> Concept | Entity, both flagged uncertain
    assert _entries(view, "get_node") == {("neo4j:Concept", "read", True, False), ("neo4j:Entity", "read", True, False)}


def test_a_literal_argument_pins_the_relationship_type_through_the_call_chain(tmp_path: Path):
    view = _view(tmp_path)
    # read_isa passes 'IS_A' -> link's f"[r:{rel}]" resolves; the node label is still one of two
    isa = next(n for n in _named(view, "link") if any(e["table"] == "neo4j-rel:IS_A" for e in n.meta.get("data", [])))
    tables = {e["table"]: e.get("uncertain", False) for e in isa.meta["data"]}
    assert tables["neo4j-rel:IS_A"] is False  # exact: the argument was a literal
    assert tables["neo4j:Concept"] is True and tables["neo4j:Entity"] is True


def test_an_unresolvable_relationship_type_is_flagged_not_dropped(tmp_path: Path):
    view = _view(tmp_path)
    flagged = [n for n in _named(view, "link") if any(e["table"] == "?" for e in n.meta.get("data", []))]
    assert flagged, "read_any(rel) passes a non-literal, so the edge type is unknown and must be reported"
    entry = next(e for e in flagged[0].meta["data"] if e["table"] == "?")
    assert entry["unattributed"] and "computed at runtime" in entry["reason"]


def test_generic_executors_are_not_reported_but_unexplained_run_calls_are(tmp_path: Path):
    view = _view(tmp_path)
    assert _entries(view, "_run") == set()  # takes `query`: its callers own the queries
    assert not _named(view, "raw")  # `raw` is not reachable from /x, so it must not appear at all


def test_wipe_reports_its_own_literal_label(tmp_path: Path):
    view = _view(tmp_path)
    assert _entries(view, "wipe") == {("neo4j:Context", "write", False, False)}


def test_rollup_lists_tables_below_without_repeating_a_functions_own(tmp_path: Path):
    view = _view(tmp_path)
    handler = view
    assert handler.meta.get("data") is None
    assert {"neo4j:Concept", "neo4j:Entity", "neo4j:Context", "neo4j-rel:IS_A"} <= set(handler.meta["below"])
    assert handler.meta["below_count"] == len(handler.meta["below"])
    read_one = next(c for c in handler.children if c.name == "read_one")
    assert "neo4j:Concept" in read_one.meta["below"]  # via get_node underneath
    get_node = _named(view, "get_node")[0]
    assert "neo4j:Concept" not in get_node.meta.get("below", [])  # its own tables are not "below"


def test_audit_counts_matched_and_lists_the_unmatched(tmp_path: Path):
    result = data_summary(_view(tmp_path))
    audit = result["audit"]
    assert audit["functions"] >= 4 and audit["matched"] < audit["functions"]
    assert any(u["name"].endswith("link") and "computed at runtime" in u["reason"] for u in audit["unmatched"])
    kinds = {t["table"]: (t["kind"], t["database"]) for t in result["tables"]}
    assert kinds["neo4j-rel:IS_A"] == ("relationship", "neo4j")
    assert kinds["neo4j:Context"] == ("label", "neo4j")
    assert next(t for t in result["tables"] if t["table"] == "neo4j:Concept")["uncertain"] is True
    assert next(t for t in result["tables"] if t["table"] == "neo4j:Context")["uncertain"] is False

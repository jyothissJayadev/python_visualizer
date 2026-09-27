"""backend/analysis/dbindex.py — every database table brain touches, as
derived from its code, across *all* endpoints.

For each table (Mongo collection / Beanie document / Neo4j label or
relationship type): the operations performed on it, the functions that perform
them, the endpoints that reach them (with the real call chain from the handler
down to the function), and the fields — read from a Beanie / Pydantic model
when there is one, otherwise inferred from what the code writes and queries.

This replaces hand-written "which function uses which table" data, which can
only drift from the code.
"""

from __future__ import annotations

from typing import Any

from backend.analysis.engine import Analysis
from backend.analysis.funcview import data_summary, function_view
from backend.analysis.relations import mongo_references, neo4j_edges

#: how far to trust where a field came from (lower = better)
_SOURCE_RANK = {"model": 0, "write": 1, "cypher": 2, "query": 3}
_DB_OF_PREFIX = {"mongo": "mongodb", "neo4j": "neo4j", "neo4j-rel": "neo4j"}
_KIND_OF_PREFIX = {"mongo": "collection", "neo4j": "label", "neo4j-rel": "relationship"}


def _new_table(table: str) -> dict[str, Any]:
    prefix, _, name = table.partition(":")
    return {
        "table": table,
        "database": _DB_OF_PREFIX.get(prefix, prefix),
        "kind": _KIND_OF_PREFIX.get(prefix, "collection"),
        "name": name,
        "ops": {},
        "uncertain": True,
        "fields": {},
        "functions": {},
        "endpoints": [],
        "edges": {},
        "indexes": [],
    }


def _merge_field(table: dict[str, Any], field: dict[str, str]) -> None:
    known = table["fields"].get(field["name"])
    if known is None:
        table["fields"][field["name"]] = dict(field)
        return
    if _SOURCE_RANK.get(field["source"], 9) < _SOURCE_RANK.get(known["source"], 9):
        known["source"] = field["source"]
    if known["type"] == "any" and field["type"] != "any":
        known["type"] = field["type"]


def build_database_index(analysis: Analysis) -> dict[str, Any]:
    registry = analysis.registry
    tables: dict[str, dict[str, Any]] = {}

    for ep in analysis.routes.endpoints:
        full = analysis.callgraph.endpoint_root(ep)
        if full is None:
            continue
        summary_line = (ep.docstring or ep.summary or "").strip().split("\n")[0][:160] or None
        for t in data_summary(function_view(full))["tables"]:
            rec = tables.setdefault(t["table"], _new_table(t["table"]))
            rec["uncertain"] = rec["uncertain"] and t["uncertain"]
            for op, n in t["ops"].items():
                rec["ops"][op] = rec["ops"].get(op, 0) + n
            for f in t["fields"]:
                _merge_field(rec, f)
            for e in t.get("edges", ()):
                known = rec["edges"].get((e["from"], e["to"]))
                rec["edges"][(e["from"], e["to"])] = e if known is None else {**known, "uncertain": known["uncertain"] and e["uncertain"]}
            ops: set[str] = set()
            chain: list[str] | None = None
            for f in t["functions"]:
                ops.add(f["op"])
                if chain is None or len(f["chain"]) < len(chain):
                    chain = f["chain"]
                key = (f["function_id"] or f["name"], f["op"])
                fn = rec["functions"].get(key)
                if fn is None:
                    info = registry.funcs.get(f["function_id"] or "")
                    fn = rec["functions"][key] = {
                        "function_id": f["function_id"], "name": f["name"], "op": f["op"], "count": 0,
                        "uncertain": True, "module": info.module if info else None,
                        "doc": info.doc if info else None, "file_path": info.file_path if info else None,
                        "line": info.line if info else None,
                    }
                fn["count"] += f["count"]
                fn["uncertain"] = fn["uncertain"] and f["uncertain"]
            rec["endpoints"].append({
                "endpoint_id": ep.id, "method": ep.method, "path": ep.path, "summary": summary_line,
                "call_chain": chain or [], "ops": sorted(ops),
            })

    # documents defined by a Beanie model are tables even if no endpoint reaches them
    for table, fields in analysis.callgraph.model_fields().items():
        rec = tables.setdefault(table, _new_table(table))
        for f in fields:
            _merge_field(rec, f)

    # indexes / constraints the code creates — a project-wide scan: they are usually made at startup
    # by functions no endpoint calls, so a table may have indexes but no endpoint at all
    for table, defs in analysis.callgraph.index_definitions().items():
        rec = tables.setdefault(table, _new_table(table))
        rec["indexes"] = defs

    out: list[dict[str, Any]] = []
    for rec in tables.values():
        rec["functions"] = sorted(rec["functions"].values(), key=lambda f: (f["op"], f["name"]))
        rec["fields"] = sorted(rec["fields"].values(), key=lambda f: (_SOURCE_RANK.get(f["source"], 9), f["name"]))
        rec["endpoints"].sort(key=lambda e: (e["path"], e["method"]))
        rec["edges"] = list(rec["edges"].values())
        if not rec["endpoints"]:
            rec["uncertain"] = False
        out.append(rec)
    out.sort(key=lambda r: (r["database"], r["kind"], r["table"]))
    return {"tables": out, "relationships": neo4j_edges(out) + mongo_references(out)}

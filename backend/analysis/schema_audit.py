"""backend/analysis/schema_audit.py — keeps the hand-written database schema
honest.

The Database view's documented schema (frontend/src/lib/databaseEngine.ts) is
for what only a person can write: field descriptions, indexes, relationships.
Which functions and endpoints touch a table is derived from the code (see
dbindex.py) precisely because hand-written lists of that kind were found to be
mostly invented. This checker finds any such reference that has crept back in
and does not exist in the code.
"""

from __future__ import annotations

import re

from backend.analysis.engine import Analysis

_FN_ID = re.compile(r'fnId:\s*"([^"]+)"')
_ENDPOINT = re.compile(r'method:\s*"([A-Z]+)"\s*,\s*path:\s*"([^"]+)"')
_RELATIONSHIP = re.compile(r'fromTableId:\s*"([^"]+)"\s*,\s*toTableId:\s*"([^"]+)"')


def find_hand_written_relationships(schema_source: str) -> list[tuple[str, str]]:
    """Table-to-table relationships written into the schema by hand. Connections
    are derived from the code now (relations.py); a hand-written one can only
    drift, so none are expected."""
    return _RELATIONSHIP.findall(schema_source)


_INDEX_KEYS = re.compile(r"keys:\s*\[")
_TABLE_ID = re.compile(r'id:\s*"((?:mongo|neo4j):[^"]+)"')
_FIELD_NAME = re.compile(r'name:\s*"([^"]+)"')


def find_hand_written_indexes(schema_source: str) -> int:
    """Indexes written into the schema by hand. They are read from the code now
    (create_index / CREATE INDEX ...), so none are expected."""
    return len(_INDEX_KEYS.findall(schema_source))


def _bracket_block(text: str, start: int) -> str:
    """The text of the [...] that opens at text[start] (a "[")."""
    depth, i = 0, start
    while i < len(text):
        c = text[i]
        if c == '"':
            i += 1
            while text[i] != '"':
                i += 2 if text[i] == "\\" else 1
        elif c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
        i += 1
    return text[start:]


def find_stale_model_fields(schema_source: str, analysis: Analysis) -> list[tuple[str, str]]:
    """Documented fields of a Beanie document that its model class does not have.
    Only this case is exact: for raw collections the code shows just what it
    happens to write or query, so a missing field there is a hint, not a fact."""
    models = analysis.callgraph.model_fields()
    marks = [(m.start(), m.group(1)) for m in _TABLE_ID.finditer(schema_source)]
    stale: list[tuple[str, str]] = []
    for k, (pos, table) in enumerate(marks):
        if table not in models:
            continue
        end = marks[k + 1][0] if k + 1 < len(marks) else len(schema_source)
        block = schema_source[pos:end]
        at = block.find("fields: [")
        if at < 0:
            continue
        documented = _FIELD_NAME.findall(_bracket_block(block, at + len("fields: ")))
        real = {f["name"] for f in models[table]}
        stale += [(table, d) for d in documented if d not in real and d not in ("_id", "id")]
    return stale


def find_stale_references(schema_source: str, analysis: Analysis) -> dict[str, list]:
    """Function ids and (method, path) pairs named in `schema_source` that the
    analyzed project does not have."""
    real_endpoints = {(e.method, e.path) for e in analysis.routes.endpoints}
    return {
        "functions": [f for f in _FN_ID.findall(schema_source) if f not in analysis.registry.funcs],
        "endpoints": [(m, p) for m, p in _ENDPOINT.findall(schema_source) if (m, p) not in real_endpoints],
    }

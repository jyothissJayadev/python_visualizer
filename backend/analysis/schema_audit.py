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


def find_stale_references(schema_source: str, analysis: Analysis) -> dict[str, list]:
    """Function ids and (method, path) pairs named in `schema_source` that the
    analyzed project does not have."""
    real_endpoints = {(e.method, e.path) for e in analysis.routes.endpoints}
    return {
        "functions": [f for f in _FN_ID.findall(schema_source) if f not in analysis.registry.funcs],
        "endpoints": [(m, p) for m, p in _ENDPOINT.findall(schema_source) if (m, p) not in real_endpoints],
    }

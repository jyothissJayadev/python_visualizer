"""The documented database schema must not name functions or endpoints that do
not exist — that data is derived from the code now (dbindex.py)."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from backend.analysis.engine import Analysis
from backend.analysis.schema_audit import find_stale_references

REPO = Path(__file__).resolve().parents[2]
SCHEMA_FILE = REPO / "frontend" / "src" / "lib" / "databaseEngine.ts"
BRAIN = Path(os.environ.get("BRAIN_PROJECT", REPO.parent / "atomics_estimate_engine" / "apps" / "brain"))


def test_checker_flags_invented_functions_and_endpoints(tmp_path: Path):
    (tmp_path / "app").mkdir()
    (tmp_path / "app" / "__init__.py").write_text("")
    (tmp_path / "app" / "svc.py").write_text("def real(): ...\n")
    (tmp_path / "app" / "main.py").write_text(
        "from fastapi import FastAPI\napp = FastAPI()\n@app.get('/things')\ndef things(): ...\n"
    )
    schema = '''
        functions: [
          { fnId: "app.svc:real", name: "real", package: "app", op: "read" },
          { fnId: "app.svc:invented", name: "invented", package: "app", op: "write" },
        ],
        endpoints: [
          { endpointId: "a", method: "GET", path: "/things", callChain: [] },
          { endpointId: "b", method: "DELETE", path: "/things/{id}", callChain: [] },
        ],
    '''
    stale = find_stale_references(schema, Analysis(str(tmp_path)))
    assert stale == {"functions": ["app.svc:invented"], "endpoints": [("DELETE", "/things/{id}")]}


@pytest.mark.skipif(not BRAIN.is_dir() or not SCHEMA_FILE.is_file(), reason="brain project or schema file not available")
def test_documented_schema_has_no_invented_links():
    stale = find_stale_references(SCHEMA_FILE.read_text(encoding="utf-8"), Analysis(str(BRAIN)))
    assert stale == {"functions": [], "endpoints": []}, (
        "databaseEngine.ts names functions / endpoints that brain does not have. Which functions and "
        "endpoints use a table is derived from the code (GET /viewer/routes/database) — do not hand-write it."
    )

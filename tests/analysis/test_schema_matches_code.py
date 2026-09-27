"""The documented database schema must not name functions or endpoints that do
not exist — that data is derived from the code now (dbindex.py)."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from backend.analysis.engine import Analysis
from backend.analysis.schema_audit import (
    find_hand_written_indexes,
    find_hand_written_relationships,
    find_stale_model_fields,
    find_stale_references,
)

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


def test_checker_finds_hand_written_relationships():
    schema = 'relationships: [ { id: "r", fromTableId: "mongo:a", toTableId: "mongo:b", type: "mongo_fk", label: "x" } ]'
    assert find_hand_written_relationships(schema) == [("mongo:a", "mongo:b")]
    assert find_hand_written_relationships("fromTableId: string; toTableId: string;") == []  # the type definition is not data


@pytest.mark.skipif(not SCHEMA_FILE.is_file(), reason="schema file not available")
def test_documented_schema_has_no_hand_written_relationships():
    found = find_hand_written_relationships(SCHEMA_FILE.read_text(encoding="utf-8"))
    assert found == [], (
        "databaseEngine.ts contains hand-written table relationships. Connections are derived from the code "
        "(GET /viewer/routes/database -> relationships): exact Neo4j edges and inferred Mongo references."
    )


def test_checker_finds_hand_written_indexes():
    assert find_hand_written_indexes('indexes: [ { name: "i", keys: ["a"] }, { name: "j", keys: ["b", "c"] } ]') == 2
    assert find_hand_written_indexes("indexes: [],") == 0


@pytest.mark.skipif(not SCHEMA_FILE.is_file(), reason="schema file not available")
def test_documented_schema_has_no_hand_written_indexes():
    assert find_hand_written_indexes(SCHEMA_FILE.read_text(encoding="utf-8")) == 0, (
        "databaseEngine.ts contains hand-written indexes. Indexes are read from the code "
        "(create_index / CREATE INDEX ...) via GET /viewer/routes/database — do not hand-write them."
    )


def test_checker_finds_documented_fields_a_model_does_not_have(tmp_path: Path):
    (tmp_path / "app").mkdir()
    (tmp_path / "app" / "__init__.py").write_text("")
    (tmp_path / "app" / "models.py").write_text(
        "from beanie import Document\nclass Project(Document):\n    project_id: str\n    summary: dict = {}\n"
    )
    schema = '''
      { id: "mongo:Project", name: "Project",
        fields: [
          { name: "_id", type: "ObjectId", isPrimary: true },
          { name: "project_id", type: "string" },
          { name: "facts", type: "dict", doc: "no longer exists" },
        ],
        indexes: [],
      },
      { id: "mongo:not_a_model", name: "x", fields: [ { name: "anything", type: "string" } ] },
    '''
    assert find_stale_model_fields(schema, Analysis(str(tmp_path))) == [("mongo:Project", "facts")]


@pytest.mark.skipif(not BRAIN.is_dir() or not SCHEMA_FILE.is_file(), reason="brain project or schema file not available")
def test_documented_model_fields_exist_in_brains_models():
    stale = find_stale_model_fields(SCHEMA_FILE.read_text(encoding="utf-8"), Analysis(str(BRAIN)))
    assert stale == [], f"documented fields that the Beanie model does not have: {stale}"

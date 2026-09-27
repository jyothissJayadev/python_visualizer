"""tests/api/test_lineage_api.py — tests for the /viewer/lineage API routes."""

import pytest
from starlette.testclient import TestClient

from backend.app import create_app
from backend.config import ExplorerConfig


@pytest.fixture
def client(tmp_path):
    config = ExplorerConfig(project_path=str(tmp_path))
    app = create_app(config, watch=False, cache_dir=tmp_path / ".cache", analyze_on_start=False)
    with TestClient(app) as test_client:
        yield test_client


def test_lineage_api_endpoint(client):
    res = client.get("/viewer/lineage")
    assert res.status_code == 200
    data = res.json()
    assert "chains" in data
    assert "summary" in data


def test_lineage_api_chain_not_found(client):
    res = client.get("/viewer/lineage/chain?id=NON_EXISTENT_ENDPOINT")
    assert res.status_code == 404

import os
import sys

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.config import ExplorerConfig

SAMPLE_PROJECT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "sample_project"))


@pytest.fixture
def client():
    original_cwd = os.getcwd()
    original_path = list(sys.path)
    modules_before = set(sys.modules)

    config = ExplorerConfig(project_path=SAMPLE_PROJECT)
    app = create_app(config)
    with TestClient(app) as test_client:
        yield test_client

    os.chdir(original_cwd)
    sys.path[:] = original_path
    for name in list(sys.modules):
        if name not in modules_before:
            del sys.modules[name]


def test_get_project_returns_scan_result(client):
    response = client.get("/api/project")
    assert response.status_code == 200
    body = response.json()
    assert body["scanned_file_count"] > 0
    assert any(m["file_path"].replace("\\", "/").endswith("math_service.py") for m in body["modules"])
    assert any(e["file_path"].replace("\\", "/").endswith("broken.py") for e in body["errors"])


def test_list_functions_returns_flat_list(client):
    response = client.get("/api/functions")
    assert response.status_code == 200
    names = {f["name"] for f in response.json()}
    assert "calculate_total" in names
    assert "generate_workflow" in names
    assert "add_and_track" in names  # method, flattened alongside top-level functions


def _function_id(client, name, class_name=None):
    for fn in client.get("/api/functions").json():
        if fn["name"] == name and fn["class_name"] == class_name:
            return fn["function_id"]
    raise AssertionError(f"{name} not found")


def test_get_function_detail_includes_source(client):
    fid = _function_id(client, "classify_number")
    response = client.get(f"/api/functions/{fid}")
    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "classify_number"
    assert "def classify_number" in body["source"]


def test_get_function_detail_404_for_unknown_id(client):
    response = client.get("/api/functions/doesnotexist")
    assert response.status_code == 404


def test_execute_function_via_api(client):
    fid = _function_id(client, "calculate_total")
    response = client.post(f"/api/functions/{fid}/execute", json={"arguments": {"items": [1, 2, 3]}})
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["output"] == 6


def test_execute_function_error_via_api(client):
    fid = _function_id(client, "divide")
    response = client.post(f"/api/functions/{fid}/execute", json={"arguments": {"a": 1, "b": 0}})
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is False
    assert body["error_type"] == "ZeroDivisionError"
    assert body["traceback"]


def test_rescan_reflects_new_function(client, tmp_path):
    new_file = os.path.join(SAMPLE_PROJECT, "utils", "_temp_rescan_test.py")
    with open(new_file, "w", encoding="utf-8") as f:
        f.write("def brand_new_function():\n    return 42\n")

    try:
        response = client.post("/api/project/rescan")
        assert response.status_code == 200
        names = {f["name"] for f in client.get("/api/functions").json()}
        assert "brand_new_function" in names
    finally:
        os.remove(new_file)
        client.post("/api/project/rescan")

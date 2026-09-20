"""tests/test_mcp_server.py — tests for the MCP Server tools."""

import pytest
from unittest.mock import patch, AsyncMock
from backend.mcp_server import (
    get_status,
    list_functions,
    arm_functions,
    get_recent_traces,
    get_function_io,
)


@pytest.mark.asyncio
async def test_mcp_get_status():
    mock_status = {
        "brain_base_url": "http://127.0.0.1:8000",
        "registered_at": "2026-09-09T00:00:00Z",
        "selection": [],
        "events_in": 42,
    }
    with patch("backend.mcp_server._fetch_get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_status
        res = await get_status()
        assert res["brain_base_url"] == "http://127.0.0.1:8000"
        mock_get.assert_called_once_with("/viewer/terminal/status")


@pytest.mark.asyncio
async def test_mcp_list_functions():
    mock_catalogue = {
        "fingerprint": "1f/2fn",
        "groups": [
            {
                "package": "app.services",
                "functions": [
                    {"id": "app.services:calc", "name": "calc", "doc": "Calculates math"},
                    {"id": "app.services:greet", "name": "greet", "doc": "Greets user"},
                ],
            }
        ],
    }
    with patch("backend.mcp_server._fetch_get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_catalogue

        # Search with query
        res = await list_functions("calc")
        assert res["total_matches"] == 1
        assert res["groups"][0]["functions"][0]["id"] == "app.services:calc"

        # Search without query
        all_res = await list_functions("")
        assert len(all_res["groups"][0]["functions"]) == 2


@pytest.mark.asyncio
async def test_mcp_arm_functions():
    with patch("backend.mcp_server._fetch_post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = {"ok": True, "armed": ["app.services:calc"], "unresolved": []}
        res = await arm_functions(["app.services:calc"], deep=True)
        assert res["ok"] is True
        mock_post.assert_called_once_with(
            "/viewer/terminal/selection",
            {"selections": [{"id": "app.services:calc", "deep": True}]},
        )


@pytest.mark.asyncio
async def test_mcp_get_recent_traces():
    mock_traces = [
        {"kind": "fn.start", "request_id": "req_1", "span_id": "s1", "data": {"name": "app.services:calc"}},
    ]
    with patch("backend.mcp_server._fetch_get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_traces
        res = await get_recent_traces(limit=5, function_id="calc")
        assert len(res) == 1
        mock_get.assert_called_once_with("/viewer/terminal/traces", params={"limit": 5, "function_id": "calc"})


@pytest.mark.asyncio
async def test_mcp_get_function_io():
    with patch("backend.mcp_server._fetch_get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = {"span_id": "s1", "field": "result", "value": 42}
        res = await get_function_io(request_id="req_1", span_id="s1", field="result")
        assert res["value"] == 42
        mock_get.assert_called_once_with("/viewer/terminal/value/req_1/s1/result")




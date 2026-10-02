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
            "/viewer/terminal/selection/update",
            {"add": [{"id": "app.services:calc", "deep": True}]},
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





@pytest.mark.asyncio
async def test_mcp_disarm_clear_and_get_armed():
    from backend.mcp_server import clear_armed, disarm_functions, get_armed

    with patch("backend.mcp_server._fetch_post", new_callable=AsyncMock) as post:
        post.return_value = {"ok": True}
        await disarm_functions([" a:f ", ""])
        post.assert_called_with("/viewer/terminal/selection/update", {"remove": ["a:f"]})
        await clear_armed()
        post.assert_called_with("/viewer/terminal/selection/update", {"clear": True})
    with patch("backend.mcp_server._fetch_get", new_callable=AsyncMock) as get:
        get.return_value = {"selection": []}
        assert await get_armed() == {"selection": []}


@pytest.mark.asyncio
async def test_mcp_arm_reports_unknown_ids_with_suggestions():
    with patch("backend.mcp_server._fetch_post", new_callable=AsyncMock) as post, \
         patch("backend.mcp_server._fetch_get", new_callable=AsyncMock) as get:
        post.return_value = {"ok": True, "armed": [], "unresolved": ["app.svc:calcc"]}
        get.return_value = {"groups": [{"functions": [{"id": "app.svc:calc"}]}]}
        res = await arm_functions(["app.svc:calcc"])
        assert res["unknown_ids"] == {"app.svc:calcc": ["app.svc:calc"]}
        assert "hint" in res


@pytest.mark.asyncio
async def test_mcp_send_request_and_errors_are_actionable():
    import httpx
    from backend.mcp_server import send_request, clear_traces

    with patch("backend.mcp_server._fetch_post", new_callable=AsyncMock) as post:
        post.return_value = {"ok": True, "request_ids": ["r1"]}
        res = await send_request("POST", "/q", {"a": 1})
        assert res["request_ids"] == ["r1"]
        post.assert_called_with("/viewer/terminal/request",
                                {"method": "POST", "path": "/q", "body": {"a": 1}, "headers": {}}, timeout=60.0)
        post.side_effect = httpx.ConnectError("refused")
        assert "cannot reach" in (await clear_traces())["error"]


@pytest.mark.asyncio
async def test_mcp_get_last_io_and_wait_for_trace():
    from backend.mcp_server import get_last_io, wait_for_trace

    spans = [{"kind": "fn.start", "request_id": "r1", "span_id": "s1"}]

    async def fake_get(path, params=None):
        if path.endswith("/traces"):
            return spans
        return {"value": path.rsplit("/", 1)[1]}

    with patch("backend.mcp_server._fetch_get", side_effect=fake_get):
        io = await get_last_io("calc")
        assert (io["input"], io["result"], io["exc"]) == ("input", "result", "exc")
        out = await wait_for_trace("calc", timeout=0.5)
        assert "no new trace" in out[0]["error"]


@pytest.mark.asyncio
async def test_mcp_list_templates():
    from backend.mcp_server import list_templates

    mock_templates = {"templates": [{"id": "tpl_1", "name": "checkout", "functions": []}]}
    with patch("backend.mcp_server._fetch_get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_templates
        res = await list_templates()
        assert res == mock_templates
        mock_get.assert_called_once_with("/viewer/terminal/templates")


@pytest.mark.asyncio
async def test_mcp_save_template_uses_get_armed_shape_not_arm_functions_shape():
    from backend.mcp_server import save_template

    functions = [{"id": "app.checkout:process_order", "deep": True}, {"id": "app.payments:charge_card", "deep": False}]
    with patch("backend.mcp_server._fetch_post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = {"template": {"id": "tpl_1", "name": "checkout", "functions": functions}}
        res = await save_template("checkout", functions)
        assert res["id"] == "tpl_1"
        mock_post.assert_called_once_with(
            "/viewer/terminal/templates", {"name": "checkout", "functions": functions}
        )


@pytest.mark.asyncio
async def test_mcp_apply_template():
    from backend.mcp_server import apply_template

    with patch("backend.mcp_server._fetch_post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = {"ok": True, "armed": ["a:b"], "unresolved": []}
        res = await apply_template("tpl_1")
        assert res["ok"] is True
        mock_post.assert_called_once_with("/viewer/terminal/templates/tpl_1/apply", {})


@pytest.mark.asyncio
async def test_mcp_update_template_omits_unset_fields():
    from backend.mcp_server import update_template

    with patch("backend.mcp_server._fetch_put", new_callable=AsyncMock) as mock_put:
        mock_put.return_value = {"template": {"id": "tpl_1", "name": "renamed"}}
        res = await update_template("tpl_1", name="renamed")
        assert res["name"] == "renamed"
        mock_put.assert_called_once_with("/viewer/terminal/templates/tpl_1", {"name": "renamed"})


@pytest.mark.asyncio
async def test_mcp_delete_template():
    from backend.mcp_server import delete_template

    with patch("backend.mcp_server._fetch_delete", new_callable=AsyncMock) as mock_delete:
        mock_delete.return_value = {"ok": True}
        res = await delete_template("tpl_1")
        assert res["ok"] is True
        mock_delete.assert_called_once_with("/viewer/terminal/templates/tpl_1")


@pytest.mark.asyncio
async def test_mcp_template_tools_surface_collector_errors():
    import httpx
    from backend.mcp_server import list_templates, save_template

    with patch("backend.mcp_server._fetch_get", new_callable=AsyncMock) as mock_get:
        mock_get.side_effect = httpx.ConnectError("refused")
        assert "cannot reach" in (await list_templates())["error"]

    with patch("backend.mcp_server._fetch_post", new_callable=AsyncMock) as mock_post:
        mock_post.side_effect = httpx.HTTPStatusError(
            "409", request=httpx.Request("POST", "http://x"),
            response=httpx.Response(409, text='{"error":"a template named \'checkout\' already exists"}'),
        )
        err = (await save_template("checkout", [{"id": "a:b", "deep": False}]))["error"]
        assert "409" in err


@pytest.mark.asyncio
async def test_mcp_write_algorithm_sends_current_body_hash():
    from backend.mcp_server import write_algorithm

    card = {"body_hash": "abc123"}
    with patch("backend.mcp_server._fetch_get", new_callable=AsyncMock) as mock_get, patch(
        "backend.mcp_server._fetch_put", new_callable=AsyncMock
    ) as mock_put:
        mock_get.return_value = card
        mock_put.return_value = {"ok": True}
        res = await write_algorithm("app.s:f", "Does a thing.", {"0": {"label": "Check input"}})
        assert res == {"ok": True}
        mock_get.assert_called_once_with("/viewer/map/algorithm", params={"id": "app.s:f"})
        sent = mock_put.call_args.args[1]["fill"]
        assert sent == {"function_id": "app.s:f", "body_hash": "abc123", "purpose": "Does a thing.",
                        "steps": {"0": {"label": "Check input"}}}


@pytest.mark.asyncio
async def test_mcp_get_map_is_compact_and_filters_by_module():
    from backend.mcp_server import get_map

    fn = lambda mod, name, deps=(): {  # noqa: E731
        "doc": None, "line": 1, "endpoints": [], "metrics": {"io": []}, "children": list(deps), "module": mod, "name": name,
    }
    full = {
        "stats": {"main": 2}, "entry_points": [], "unreached": [],
        "functions": {"a.x:f": fn("a.x", "f"), "b.y:g": fn("b.y", "g")},
        "modules": [{"module": "a.x", "layer": "api", "functions": ["a.x:f"]}, {"module": "b.y", "layer": "core", "functions": ["b.y:g"]}],
        "edges": [{"from": "a.x:f", "to": "b.y:g"}],
    }
    with patch("backend.mcp_server._fetch_get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = full
        res = await get_map(module="b.y")
        assert [m["module"] for m in res["modules"]] == ["b.y"]
        assert res["links"] == ["a.x:f -> b.y:g"]

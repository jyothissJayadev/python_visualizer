"""backend/mcp_server.py — Model Context Protocol (MCP) server for Brain Terminal.

Allows Claude Code and other MCP clients to:
  1. Inspect available functions and signatures in the codebase.
  2. Arm/instrument functions for runtime tracing via sys.monitoring.
  3. Query recent execution traces, call trees, inputs, and outputs.
  4. Fetch full (untruncated) function arguments, return values, and exceptions.
  5. Trigger test requests to the live backend to verify code behavior.
"""

from __future__ import annotations

import asyncio
import difflib
import os
import time
from typing import Any
import httpx

try:
    from mcp.server.mcpserver import MCPServer
    mcp = MCPServer("brain-telemetry")
except ImportError:
    from mcp.server.fastmcp import FastMCP  # type: ignore
    mcp = FastMCP("brain-telemetry")

COLLECTOR_URL = os.environ.get("BRAIN_COLLECTOR_URL", "http://127.0.0.1:8011").rstrip("/")


def _explain(exc: Exception) -> str:
    """One-line, actionable description of why a collector call failed."""
    if isinstance(exc, httpx.ConnectError):
        return (
            f"cannot reach the Brain Terminal collector at {COLLECTOR_URL} — start it "
            "(python -m backend.dev / uvicorn backend.main:app) or set BRAIN_COLLECTOR_URL"
        )
    if isinstance(exc, httpx.HTTPStatusError):
        detail = exc.response.text[:300]
        if exc.response.status_code == 503 and "brain not registered" in detail:
            return "the target backend (brain) is not registered — start it with telemetry enabled"
        return f"collector returned HTTP {exc.response.status_code}: {detail}"
    return f"{type(exc).__name__}: {exc}"


async def _fetch_get(path: str, params: dict | None = None) -> Any:
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(f"{COLLECTOR_URL}{path}", params=params)
        resp.raise_for_status()
        return resp.json()


async def _fetch_post(path: str, json_data: dict, timeout: float = 30.0) -> Any:
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(f"{COLLECTOR_URL}{path}", json=json_data)
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def get_status() -> dict[str, Any]:
    """Get the current status of the Brain Terminal collector, connected brain instance,
    active armed function selections, and event counters.
    """
    try:
        return await _fetch_get("/viewer/terminal/status")
    except Exception as exc:  # noqa: BLE001
        return {"error": _explain(exc)}


@mcp.tool()
async def list_functions(query: str = "", limit: int = 200) -> dict[str, Any]:
    """Search and list all functions/methods discovered in the Python backend source code.

    Args:
        query: Optional string to filter functions by id, name, signature or docstring (case-insensitive).
        limit: Max functions returned (default 200) — narrow the query when truncated.
    """
    try:
        data = await _fetch_get("/viewer/terminal/functions")
        groups = data.get("groups", [])
        if not query:
            return _limit_groups(data.get("fingerprint"), groups, limit)

        q = query.lower()
        filtered_groups = []
        total_matches = 0
        for group in groups:
            matched_fns = [
                fn
                for fn in group.get("functions", [])
                if q in fn.get("id", "").lower()
                or q in fn.get("name", "").lower()
                or q in fn.get("signature", "").lower()
                or q in fn.get("doc", "").lower()
            ]
            if matched_fns:
                filtered_groups.append({"package": group.get("package"), "functions": matched_fns})
                total_matches += len(matched_fns)

        out = _limit_groups(data.get("fingerprint"), filtered_groups, limit)
        out["total_matches"] = total_matches
        return out
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Failed to list functions: {_explain(exc)}"}


def _limit_groups(fingerprint: Any, groups: list[dict], limit: int) -> dict[str, Any]:
    out, count = [], 0
    for group in groups:
        fns = group.get("functions", [])[: max(0, limit - count)]
        if fns:
            out.append({"package": group.get("package"), "functions": fns})
            count += len(fns)
    total = sum(len(g.get("functions", [])) for g in groups)
    return {"fingerprint": fingerprint, "returned": count, "truncated": count < total, "groups": out}


async def _catalog_ids() -> set[str]:
    data = await _fetch_get("/viewer/terminal/functions")
    return {fn["id"] for g in data.get("groups", []) for fn in g.get("functions", [])}


async def _update_selection(payload: dict) -> dict[str, Any]:
    try:
        return await _fetch_post("/viewer/terminal/selection/update", payload)
    except Exception as exc:  # noqa: BLE001
        return {"error": _explain(exc)}


@mcp.tool()
async def arm_functions(function_ids: list[str], deep: bool = False) -> dict[str, Any]:
    """ADD functions to the armed set (already-armed ones are kept; re-adding changes their deep flag).

    Args:
        function_ids: Function IDs in 'module.path:QualName' format
                      (e.g., ['app.services.quote:calculate_quote']).
        deep: If True, also traces every nested call made inside these functions.
              If False (shallow), traces only entry/exit, arguments and return value.

    IDs not present in the scanned catalogue are reported under `unknown_ids` with close
    matches; run `rescan_functions` first if you just added/renamed code.
    """
    ids = [f.strip() for f in function_ids if f.strip()]
    result = await _update_selection({"add": [{"id": f, "deep": deep} for f in ids]})
    try:
        known = await _catalog_ids()
        unknown = [f for f in ids if f not in known]
        if unknown:
            result["unknown_ids"] = {f: difflib.get_close_matches(f, known, n=3, cutoff=0.5) for f in unknown}
    except Exception:  # noqa: BLE001
        pass
    if result.get("unresolved"):
        result["hint"] = "brain could not resolve some ids — is it running the current code? (rescan / restart brain)"
    return result


@mcp.tool()
async def disarm_functions(function_ids: list[str]) -> dict[str, Any]:
    """REMOVE functions from the armed set (others stay armed). Use `clear_armed` to remove all."""
    return await _update_selection({"remove": [f.strip() for f in function_ids if f.strip()]})


@mcp.tool()
async def clear_armed() -> dict[str, Any]:
    """Disarm every function (stops all tracing)."""
    return await _update_selection({"clear": True})


@mcp.tool()
async def get_armed() -> dict[str, Any]:
    """List the currently armed functions ({id, deep}) and whether brain is connected."""
    try:
        return await _fetch_get("/viewer/terminal/selection")
    except Exception as exc:  # noqa: BLE001
        return {"error": _explain(exc)}


@mcp.tool()
async def rescan_functions() -> dict[str, Any]:
    """Re-scan the target's source so newly added/renamed/removed functions appear in `list_functions`.
    Call this after editing code."""
    try:
        data = await _fetch_post("/viewer/terminal/rescan", {})
        return {"fingerprint": data.get("fingerprint"), "packages": len(data.get("groups", []))}
    except Exception as exc:  # noqa: BLE001
        return {"error": _explain(exc)}


@mcp.tool()
async def clear_traces() -> dict[str, Any]:
    """Drop all buffered trace events so the next run can be inspected in isolation."""
    try:
        return await _fetch_post("/viewer/terminal/traces/clear", {})
    except Exception as exc:  # noqa: BLE001
        return {"error": _explain(exc)}


@mcp.tool()
async def send_request(
    method: str = "GET",
    path: str = "/",
    body: Any = None,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Send an HTTP request to the target backend (brain) to exercise armed functions.

    Only the registered brain is reachable; `path` must be relative (e.g. '/quotes/1?x=2').
    Returns status, response body and `request_ids` — pass one to `get_recent_traces` /
    `get_function_io` to inspect what happened.
    """
    try:
        return await _fetch_post(
            "/viewer/terminal/request",
            {"method": method, "path": path, "body": body, "headers": headers or {}},
            timeout=60.0,
        )
    except Exception as exc:  # noqa: BLE001
        return {"error": _explain(exc)}


@mcp.tool()
async def get_recent_traces(
    limit: int = 20,
    function_id: str = "",
    request_id: str = "",
    kind: str = "",
) -> list[dict[str, Any]]:
    """Retrieve recent runtime execution events, function spans, and logs.

    Args:
        limit: Number of recent events to return (max 500, default 20).
        function_id: Optional filter for a specific function name or ID.
        request_id: Optional filter for a specific HTTP request trace ID.
        kind: Optional event kind filter (e.g. 'span', 'request', 'log').
    """
    params: dict[str, Any] = {"limit": limit}
    if function_id:
        params["function_id"] = function_id
    if request_id:
        params["request_id"] = request_id
    if kind:
        params["kind"] = kind

    try:
        return await _fetch_get("/viewer/terminal/traces", params=params)
    except Exception as exc:  # noqa: BLE001
        return [{"error": f"Failed to get traces: {_explain(exc)}"}]


@mcp.tool()
async def get_function_io(request_id: str, span_id: str, field: str = "result") -> dict[str, Any]:
    """Fetch untruncated runtime input arguments, return value, or exception traceback for a specific span.

    Args:
        request_id: The request ID from the trace event.
        span_id: The span ID of the function call.
        field: 'input' (function arguments), 'result' (return value), or 'exc' (exception details).
    """
    try:
        return await _fetch_get(f"/viewer/terminal/value/{request_id}/{span_id}/{field}")
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Failed to get span value: {_explain(exc)}"}


@mcp.tool()
async def wait_for_trace(function_id: str, timeout: float = 10.0) -> list[dict[str, Any]]:
    """Block until a NEW trace event for `function_id` arrives (or `timeout` seconds pass), then return
    the matching events. Call it right after triggering the flow, or use `send_request` which already waits briefly."""
    params = {"limit": 500, "function_id": function_id}
    try:
        seen = len(await _fetch_get("/viewer/terminal/traces", params=params))
        deadline = time.monotonic() + max(0.5, min(timeout, 60.0))
        while time.monotonic() < deadline:
            await asyncio.sleep(0.5)
            events = await _fetch_get("/viewer/terminal/traces", params=params)
            if len(events) > seen:
                return events[seen:]
        return [{"error": f"no new trace for {function_id!r} within {timeout}s — is it armed and was the flow triggered?"}]
    except Exception as exc:  # noqa: BLE001
        return [{"error": _explain(exc)}]


@mcp.tool()
async def get_last_io(function_id: str) -> dict[str, Any]:
    """Newest recorded call of a function: its input, result and exception in one call."""
    try:
        events = await _fetch_get("/viewer/terminal/traces", params={"limit": 500, "function_id": function_id})
        spans = [e for e in events if e.get("span_id") and e.get("request_id")]
        if not spans:
            return {"error": f"no spans recorded for {function_id!r} — arm it and trigger the flow"}
        last = spans[-1]
        rid, sid = last["request_id"], last["span_id"]
        out: dict[str, Any] = {"request_id": rid, "span_id": sid, "event": last}
        for field in ("input", "result", "exc"):
            try:
                out[field] = (await _fetch_get(f"/viewer/terminal/value/{rid}/{sid}/{field}")).get("value")
            except Exception:  # noqa: BLE001
                out[field] = None
        return out
    except Exception as exc:  # noqa: BLE001
        return {"error": _explain(exc)}


def main():
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()

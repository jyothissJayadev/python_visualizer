"""backend/mcp_server.py — Model Context Protocol (MCP) server for Brain Terminal.

Allows Claude Code and other MCP clients to:
  1. Inspect available functions and signatures in the codebase.
  2. Arm/instrument functions for runtime tracing via sys.monitoring.
  3. Query recent execution traces, call trees, inputs, and outputs.
  4. Fetch full (untruncated) function arguments, return values, and exceptions.
  5. Trigger test requests to the live backend to verify code behavior.
"""

from __future__ import annotations

import os
import sys
from typing import Any
import httpx

try:
    from mcp.server.mcpserver import MCPServer
    mcp = MCPServer("brain-telemetry")
except ImportError:
    from mcp.server.fastmcp import FastMCP  # type: ignore
    mcp = FastMCP("brain-telemetry")

COLLECTOR_URL = os.environ.get("BRAIN_COLLECTOR_URL", "http://127.0.0.1:8011").rstrip("/")


async def _fetch_get(path: str, params: dict | None = None) -> Any:
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(f"{COLLECTOR_URL}{path}", params=params)
        resp.raise_for_status()
        return resp.json()


async def _fetch_post(path: str, json_data: dict) -> Any:
    async with httpx.AsyncClient(timeout=30.0) as client:
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
        return {"error": f"Failed to connect to collector at {COLLECTOR_URL}: {exc}"}


@mcp.tool()
async def list_functions(query: str = "") -> dict[str, Any]:
    """Search and list all functions/methods discovered in the Python backend source code.

    Args:
        query: Optional string to filter functions by name, module, or signature (case-insensitive).
    """
    try:
        data = await _fetch_get("/viewer/terminal/functions")
        groups = data.get("groups", [])
        if not query:
            return {"fingerprint": data.get("fingerprint"), "groups": groups}

        q = query.lower()
        filtered_groups = []
        total_matches = 0
        for group in groups:
            matched_fns = [
                fn
                for fn in group.get("functions", [])
                if q in fn.get("id", "").lower()
                or q in fn.get("name", "").lower()
                or q in fn.get("doc", "").lower()
            ]
            if matched_fns:
                filtered_groups.append({"package": group.get("package"), "functions": matched_fns})
                total_matches += len(matched_fns)

        return {
            "fingerprint": data.get("fingerprint"),
            "total_matches": total_matches,
            "groups": filtered_groups,
        }
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Failed to list functions: {exc}"}


@mcp.tool()
async def arm_functions(function_ids: list[str], deep: bool = False) -> dict[str, Any]:
    """Arm/instrument specific functions in the running Python backend to trace their execution.

    Args:
        function_ids: List of target function IDs in 'module.path:QualName' format
                      (e.g., ['app.services.quote:calculate_quote', 'app.core.auth:verify_token']).
        deep: If True, recursively traces all nested function calls executed inside these functions.
              If False (shallow), traces only the entry/exit, arguments, and return value of the specified function.
    """
    try:
        selections = [{"id": fid.strip(), "deep": deep} for fid in function_ids if fid.strip()]
        return await _fetch_post("/viewer/terminal/selection", {"selections": selections})
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Failed to arm functions: {exc}"}


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
        return [{"error": f"Failed to get traces: {exc}"}]


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
        return {"error": f"Failed to get span value: {exc}"}


@mcp.tool()
async def run_test_request(
    message: str = "",
    domain: str = "quotation",
    session_id: str = "",
) -> dict[str, Any]:
    """Trigger a test HTTP request to the running backend to execute code and generate traces.

    Args:
        message: Input message or prompt to send.
        domain: Domain endpoint to target ('quotation', 'execution', 'quotation_edit', or 'extraction').
        session_id: Optional session identifier.
    """
    try:
        payload = {"message": message, "domain": domain, "session_id": session_id}
        return await _fetch_post("/viewer/terminal/test", payload)
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Failed to run test request: {exc}"}


def main():
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()

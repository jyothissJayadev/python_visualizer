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


async def _fetch_put(path: str, json_data: dict, timeout: float = 30.0) -> Any:
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.put(f"{COLLECTOR_URL}{path}", json=json_data)
        resp.raise_for_status()
        return resp.json()


async def _fetch_delete(path: str, timeout: float = 30.0) -> Any:
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.delete(f"{COLLECTOR_URL}{path}")
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
async def list_templates() -> dict[str, Any]:
    """List saved Trace Templates — named, reusable groups of functions to arm
    together. Each function is annotated with its live status against the
    current source scan ('ok', 'missing', or 'unknown' before the first scan)
    plus up to 3 rename suggestions when missing. This annotation is
    informational only — apply_template always arms every saved function."""
    try:
        return await _fetch_get("/viewer/terminal/templates")
    except Exception as exc:  # noqa: BLE001
        return {"error": _explain(exc)}


@mcp.tool()
async def save_template(name: str, functions: list[dict[str, Any]]) -> dict[str, Any]:
    """Save a named Trace Template so this exact set of functions can be re-armed later in one call.

    Args:
        name: Template name — must be non-empty and unique among existing templates.
        functions: [{"id": "module.path:QualName", "deep": bool}, ...] — the same
                   per-function shape `get_armed()` returns. This is NOT the same
                   shape `arm_functions` takes (that applies one shared `deep` flag
                   to a whole batch, and can't express mixed modes). If the
                   functions you want to save were armed across multiple
                   `arm_functions` calls with different `deep` values, call
                   `get_armed()` first to recover the true per-function modes,
                   then pass that list here.
    """
    try:
        data = await _fetch_post("/viewer/terminal/templates", {"name": name, "functions": functions})
        return data.get("template", data)
    except Exception as exc:  # noqa: BLE001
        return {"error": _explain(exc)}


@mcp.tool()
async def apply_template(template_id: str) -> dict[str, Any]:
    """Arm every function saved in a Trace Template with its saved deep/shallow
    mode. Replaces the currently armed set, same as applying a manual selection."""
    try:
        return await _fetch_post(f"/viewer/terminal/templates/{template_id}/apply", {})
    except Exception as exc:  # noqa: BLE001
        return {"error": _explain(exc)}


@mcp.tool()
async def update_template(
    template_id: str, name: str | None = None, functions: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    """Rename a Trace Template and/or replace its function list. Omit a field to leave it unchanged."""
    payload: dict[str, Any] = {}
    if name is not None:
        payload["name"] = name
    if functions is not None:
        payload["functions"] = functions
    try:
        data = await _fetch_put(f"/viewer/terminal/templates/{template_id}", payload)
        return data.get("template", data)
    except Exception as exc:  # noqa: BLE001
        return {"error": _explain(exc)}


@mcp.tool()
async def delete_template(template_id: str) -> dict[str, Any]:
    """Delete a saved Trace Template."""
    try:
        return await _fetch_delete(f"/viewer/terminal/templates/{template_id}")
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
async def get_map(module: str = "") -> dict[str, Any]:
    """The project map: entry points, endpoints, main functions per module and the links between them.
    Small helpers are folded into the main function that calls them (see `children`). Start here to
    understand the project's shape before changing it.

    Args:
        module: Optional module name (e.g. 'app.services') to list only that module's main functions.
    """
    try:
        m = await _fetch_get("/viewer/map")
        fns = m["functions"]

        def brief(fid: str) -> dict[str, Any]:
            f = fns[fid]
            return {
                "id": fid, "doc": f.get("doc"), "line": f["line"], "endpoints": f["endpoints"],
                "io": f["metrics"]["io"], "helpers": f.get("children", []),
            }

        mods = [x for x in m["modules"] if not module or x["module"] == module]
        return {
            "stats": m["stats"],
            "entry_points": m["entry_points"],
            "modules": [{"module": x["module"], "layer": x["layer"], "functions": [brief(f) for f in x["functions"]]} for x in mods],
            "links": [f"{e['from']} -> {e['to']}" for e in m["edges"] if not module or fns[e["from"]]["module"] == module or fns[e["to"]]["module"] == module],
            "unreached": m["unreached"][:50],
        }
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Failed to get map: {_explain(exc)}"}


@mcp.tool()
async def get_algorithm(function_id: str) -> dict[str, Any]:
    """Algorithm card of one function: facts (signature, raises, returns), an ordered list of steps
    (calls, decisions, loops, raises, returns) with stable ids, and a purpose line. Steps and facts come
    from the code and cannot be changed; `fill_status` says whether the wording was agent-written."""
    try:
        return await _fetch_get("/viewer/map/algorithm", params={"id": function_id})
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Failed to get algorithm: {_explain(exc)}"}


@mcp.tool()
async def write_algorithm(function_id: str, purpose: str, steps: dict[str, dict[str, str]] | None = None) -> dict[str, Any]:
    """Write the wording of a function's algorithm card. You fill in blanks only: a one-line `purpose`
    and, per existing step id, a `label` (short plain-English name) and/or a `note` (why it happens).
    You cannot add, remove or reorder steps; unknown step ids are rejected. Call get_algorithm first.

    Args:
        function_id: 'module.path:QualName'.
        purpose: What the function achieves, in one or two sentences (max 240 chars).
        steps: {step_id: {"label": "...", "note": "..."}} for the steps worth explaining (max 120 / 240 chars).
    """
    try:
        card = await _fetch_get("/viewer/map/algorithm", params={"id": function_id})
        fill = {"function_id": function_id, "body_hash": card["body_hash"], "purpose": purpose, "steps": steps or {}}
        return await _fetch_put("/viewer/map/algorithm", {"fill": fill})
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 422:
            return {"error": "fill rejected", "problems": exc.response.json().get("detail", {}).get("problems")}
        return {"error": f"Failed to write algorithm: {_explain(exc)}"}
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Failed to write algorithm: {_explain(exc)}"}


@mcp.tool()
async def pin_function(function_id: str, role: str = "") -> dict[str, Any]:
    """Pin a function as 'main' (shown on the map) or 'child' (folded into its callers). Empty role resets
    it to the automatic score."""
    if role not in ("", "main", "child"):
        return {"error": "role must be 'main', 'child' or ''"}
    try:
        return await _fetch_put("/viewer/map/overrides", {"id": function_id, "role": role or None})
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Failed to pin: {_explain(exc)}"}


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

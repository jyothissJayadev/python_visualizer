"""backend/analysis/overlay.py — merges brain's runtime traces onto the static
call hierarchy.

The static tree says what *can* run; traces (``fn.start`` / ``fn.end`` /
``fn.error`` spans streamed by brain's ``sys.monitoring`` tracer) say what
*did*. This module turns the collector's recent events into, per endpoint:

  * **functions** — per function id: calls, requests, avg/max ms, errors, and
    the last call's args / result / exception (previews)
  * **confirmed** — "caller>callee" pairs seen at runtime (a static edge is
    confirmed when the callee's span had the caller among its ancestors)
  * **extras** — callees observed directly under a function that the static
    tree does not contain anywhere below it (dynamic dispatch, callbacks…),
    which is how unresolved nodes get filled in
  * **armed** — which functions are currently armed, and how (deep/shallow)

Only *armed* functions emit spans, so "not observed" never means "did not
run" — the UI shows armed state next to it. The overlay is computed on
demand from the collector's in-memory ring buffer; nothing is persisted.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from typing import Any, Iterable

from backend.analysis.callgraph import N

PREVIEW_CHARS = 3000
MAX_REQUESTS_LISTED = 20


def path_matcher(pattern: str) -> re.Pattern[str]:
    """"/a/{id}/b" -> regex; "{x:path}" matches across slashes."""
    out = ""
    for part in re.split(r"(\{[^}]+\})", pattern):
        if part.startswith("{") and part.endswith("}"):
            out += ".+" if part[1:-1].endswith(":path") else "[^/]+"
        else:
            out += re.escape(part)
    return re.compile(out + "/?")


def _specificity(pattern: str) -> tuple[int, int]:
    literal = len(re.sub(r"\{[^}]+\}", "", pattern))
    return (literal, -pattern.count("{"))


class EndpointMatcher:
    """Maps a concrete request (method, path) to the most specific endpoint."""

    def __init__(self, endpoints: Iterable[tuple[str, str, str]]):
        self._entries = [(eid, method, path, path_matcher(path)) for eid, method, path in endpoints]

    def match(self, method: str, path: str) -> str | None:
        path = path.split("?", 1)[0]
        best: tuple[tuple[int, int], str] | None = None
        for eid, m, pattern, rx in self._entries:
            if m != method or not rx.fullmatch(path):
                continue
            score = _specificity(pattern)
            if best is None or score > best[0]:
                best = (score, eid)
        return best[1] if best else None


def _clip(value: Any) -> Any:
    """Keep previews small: anything whose JSON exceeds PREVIEW_CHARS is cut."""
    try:
        text = json.dumps(value, default=str, ensure_ascii=False)
    except (TypeError, ValueError):
        text = str(value)
    if len(text) <= PREVIEW_CHARS:
        return value
    return text[:PREVIEW_CHARS] + "…"


def build_overlay(
    events: list[dict],
    endpoint_id: str,
    matcher: EndpointMatcher,
    armed: list[dict],
) -> dict[str, Any]:
    # 1. requests that belong to this endpoint
    requests: dict[str, dict[str, Any]] = {}
    for e in events:
        rid = e.get("request_id")
        kind = e.get("kind")
        if not rid:
            continue
        data = e.get("data") or {}
        if kind == "request.start":
            if matcher.match(str(data.get("method", "")).upper(), str(data.get("path", ""))) == endpoint_id:
                requests[rid] = {"request_id": rid, "ts": e.get("ts"), "status": None, "duration_ms": None, "spans": 0}
        elif kind == "request.end" and rid in requests:
            requests[rid]["status"] = data.get("status")
            requests[rid]["duration_ms"] = data.get("duration_ms")

    # 2. spans of those requests
    spans: dict[tuple[str, str], dict[str, Any]] = {}
    for e in events:
        rid = e.get("request_id")
        kind = e.get("kind")
        if rid not in requests or kind not in ("fn.start", "fn.end", "fn.error"):
            continue
        sid = e.get("span_id")
        if not sid:
            continue
        data = e.get("data") or {}
        span = spans.setdefault((rid, sid), {"request_id": rid, "span_id": sid, "name": data.get("name"), "parent": None})
        if e.get("parent_span_id"):
            span["parent"] = e["parent_span_id"]
        if kind == "fn.start":
            span.update(name=data.get("name"), ts=e.get("ts"), args=data.get("args"), args_truncated=data.get("args_truncated"))
            requests[rid]["spans"] += 1
        elif kind == "fn.end":
            span.update(duration_ms=data.get("duration_ms"), result=data.get("result"), result_truncated=data.get("result_truncated"))
        else:
            span.update(
                duration_ms=data.get("duration_ms"),
                error={"type": data.get("exc_type"), "message": data.get("message")},
            )

    # 3. aggregate
    functions: dict[str, dict[str, Any]] = {}
    confirmed: set[str] = set()
    children: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for (rid, sid), span in spans.items():
        name = span.get("name")
        if not name:
            continue
        agg = functions.setdefault(
            name, {"calls": 0, "requests": set(), "total_ms": 0, "max_ms": 0, "errors": 0, "last": None, "_last_ts": -1.0}
        )
        agg["calls"] += 1
        agg["requests"].add(rid)
        dur = span.get("duration_ms") or 0
        agg["total_ms"] += dur
        agg["max_ms"] = max(agg["max_ms"], dur)
        if span.get("error"):
            agg["errors"] += 1
        ts = span.get("ts") or 0.0
        if ts >= agg["_last_ts"]:
            agg["_last_ts"] = ts
            agg["last"] = {
                "request_id": rid, "span_id": sid, "ts": span.get("ts"), "duration_ms": span.get("duration_ms"),
                "args": _clip(span.get("args")), "args_truncated": bool(span.get("args_truncated")),
                "result": _clip(span.get("result")), "result_truncated": bool(span.get("result_truncated")),
                "error": span.get("error"),
            }
        # ancestors -> confirmed edges; direct parent -> children map
        parent_sid = span.get("parent")
        parent = spans.get((rid, parent_sid)) if parent_sid else None
        if parent and parent.get("name"):
            children[parent["name"]][name] += 1
        seen = 0
        while parent is not None and seen < 200:
            if parent.get("name"):
                confirmed.add(f"{parent['name']}>{name}")
            nxt = parent.get("parent")
            parent = spans.get((rid, nxt)) if nxt else None
            seen += 1

    out_functions = {
        name: {
            "calls": a["calls"], "requests": len(a["requests"]), "avg_ms": round(a["total_ms"] / a["calls"], 1),
            "max_ms": a["max_ms"], "errors": a["errors"], "last": a["last"],
        }
        for name, a in functions.items()
    }
    listed = sorted(requests.values(), key=lambda r: r.get("ts") or 0, reverse=True)
    return {
        "endpoint_id": endpoint_id,
        "request_count": len(requests),
        "requests": listed[:MAX_REQUESTS_LISTED],
        "span_count": len(spans),
        "functions": out_functions,
        "confirmed": sorted(confirmed),
        "armed": {a["id"]: bool(a.get("deep")) for a in armed if a.get("id")},
        "_children": {p: dict(c) for p, c in children.items()},
    }


def compute_extras(root: N, children: dict[str, dict[str, int]]) -> dict[str, list[dict[str, Any]]]:
    """For each function with observed direct callees: those callees that do
    not appear anywhere in its static subtree."""
    if not children:
        return {}
    first: dict[str, N] = {}
    stack = [root]
    seen: set[int] = set()
    while stack:
        n = stack.pop()
        if id(n) in seen:
            continue
        seen.add(id(n))
        if n.kind == "function" and n.function_id and n.function_id in children and n.function_id not in first:
            first[n.function_id] = n
        stack.extend(n.children)

    extras: dict[str, list[dict[str, Any]]] = {}
    for fid, node in first.items():
        below: set[str] = set()
        todo = list(node.children)
        visited: set[int] = set()
        while todo:
            m = todo.pop()
            if id(m) in visited:
                continue
            visited.add(id(m))
            if m.function_id:
                below.add(m.function_id)
            todo.extend(m.children)
        missing = [
            {"function_id": callee, "calls": count}
            for callee, count in sorted(children[fid].items(), key=lambda kv: -kv[1])
            if callee not in below and callee != fid
        ]
        if missing:
            extras[fid] = missing
    return extras

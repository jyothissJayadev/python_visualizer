"""backend/analysis/mapmodel.py — the project "map": entry points, the main
(meaningful) functions, and how they connect, with small helpers folded into
the parent that calls them.

Everything here is deterministic. Facts come from the static call graph
(callgraph.py); the only judgement call — which function is "main" — is a
transparent score (``score_function``) whose reasons are returned with every
function, and which a small overrides dict (``{function_id: "main"|"child"}``)
can pin either way.

  * edges are walked once per endpoint through the shared-subtree call graph,
    looking through loop / branch / arm marker nodes
  * a function is a *child* (folded) when it is a leaf with no I/O, or scores
    below ``MAIN_THRESHOLD``; handlers and entry points are always main
  * main -> main edges are collapsed through child chains, so the map shows
    "A leads to B" even when only a helper sits between them
  * a child used by several mains is listed under each of them (``used_by``)
"""

from __future__ import annotations

import ast
from collections import defaultdict
from typing import Any

from backend.analysis.callgraph import N
from backend.analysis.engine import Analysis

MAIN_THRESHOLD = 12.0
LAYER_HINTS = (
    ("router", "api"), ("route", "api"), ("endpoint", "api"), ("api", "api"), ("handler", "api"),
    ("service", "service"), ("usecase", "service"), ("workflow", "service"), ("logic", "service"),
    ("repo", "data"), ("model", "data"), ("db", "data"), ("database", "data"), ("schema", "data"), ("store", "data"),
    ("util", "util"), ("helper", "util"), ("common", "util"), ("lib", "util"),
)


def layer_of(module: str) -> str:
    low = module.lower()
    for hint, layer in LAYER_HINTS:
        if hint in low:
            return layer
    return "core"


def score_function(m: dict[str, Any]) -> tuple[float, list[str]]:
    """Score a function's metrics. Returns (score, human-readable reasons)."""
    reasons: list[str] = []
    score = 0.0
    if m["fan_out"]:
        s = 3.0 * min(m["fan_out"], 8)
        score += s
        reasons.append(f"calls {m['fan_out']} function(s) (+{s:g})")
    if m["io"]:
        score += 15
        reasons.append("touches I/O: " + ", ".join(m["io"][:3]) + " (+15)")
    if m["endpoints"] > 1 and m["fan_out"]:
        s = 4.0 * min(m["endpoints"], 5)
        score += s
        reasons.append(f"reached from {m['endpoints']} endpoints (+{s:g})")
    if m["branches"]:
        score += 5
        reasons.append("has branching logic (+5)")
    s = min(m["loc"], 60) / 4
    if s >= 1:
        score += s
        reasons.append(f"{m['loc']} lines (+{s:g})")
    if m["private"]:
        score -= 10
        reasons.append("private name (-10)")
    if m["loc"] <= 4 and m["fan_out"] <= 1:
        score -= 15
        reasons.append("tiny wrapper (-15)")
    return score, reasons


def _walk_funcs(node: N, parent: str | None, visit: Any, seen: set[int]) -> None:
    """Depth-first over the shared-subtree tree, once per node object; calls
    ``visit(parent_fid, node)`` for every function node."""
    key = id(node)
    if key in seen:
        return
    seen.add(key)
    here = parent
    if node.kind == "function" and node.function_id:
        visit(parent, node)
        here = node.function_id
    for child in node.children:
        _walk_funcs(child, here, visit, seen)


def _io_of(node: N) -> str | None:
    if node.kind == "db":
        return f"db:{node.name}"
    if node.kind == "external" and node.external:
        return f"ext:{node.external.split('.')[0]}"
    return None


def _branches(fn_node: ast.AST) -> int:
    n = 0
    stack = list(ast.iter_child_nodes(fn_node))
    while stack:
        x = stack.pop()
        if isinstance(x, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        if isinstance(x, (ast.If, ast.Try, ast.Match)):
            n += 1
        stack.extend(ast.iter_child_nodes(x))
    return n


def _entry_points(analysis: Analysis) -> list[dict[str, Any]]:
    out = []
    for module, assigns in analysis.registry.module_assigns.items():
        for name, value in assigns.items():
            if isinstance(value, ast.Call):
                fn = value.func
                called = fn.id if isinstance(fn, ast.Name) else fn.attr if isinstance(fn, ast.Attribute) else None
                if called in ("FastAPI", "Starlette"):
                    mod = analysis.index.modules.get(module)
                    out.append({
                        "id": f"{module}:{name}", "kind": "app", "framework": called, "module": module,
                        "file_path": mod.file_path if mod else None, "line": value.lineno,
                    })
    return out


def build_map(analysis: Analysis, overrides: dict[str, str] | None = None) -> dict[str, Any]:
    overrides = overrides or {}
    reg = analysis.registry
    cg = analysis.callgraph

    parents: dict[str, set[str]] = defaultdict(set)
    kids: dict[str, set[str]] = defaultdict(set)
    edge_kind: dict[tuple[str, str], str] = {}
    io: dict[str, set[str]] = defaultdict(set)
    reached_by: dict[str, set[str]] = defaultdict(set)
    handlers: dict[str, list[str]] = defaultdict(list)
    depends_ids: set[str] = set()
    depth: dict[str, int] = {}
    unresolved: dict[str, int] = defaultdict(int)

    for ep in analysis.routes.endpoints:
        root = cg.endpoint_root(ep)
        if root is None:
            continue
        handlers[ep.handler_id].append(ep.id)
        seen: set[int] = set()

        def visit(parent: str | None, node: N, ep_id: str = ep.id) -> None:
            fid = node.function_id
            assert fid is not None
            reached_by[fid].add(ep_id)
            if parent is not None and parent != fid:
                parents[fid].add(parent)
                kids[parent].add(fid)
                edge_kind.setdefault((parent, fid), node.edge)
            if node.edge == "depends":
                depends_ids.add(fid)

        _walk_funcs(root, None, visit, seen)

        # I/O + unresolved calls belong to the nearest enclosing function
        def io_pass(node: N, owner: str | None, seen2: set[int]) -> None:
            if id(node) in seen2:
                return
            seen2.add(id(node))
            here = node.function_id if node.kind == "function" and node.function_id else owner
            tag = _io_of(node)
            if tag and here:
                io[here].add(tag)
            if node.kind == "unresolved" and here:
                unresolved[here] += 1
            for c in node.children:
                io_pass(c, here, seen2)

        io_pass(root, None, set())

        # shortest distance from the entry (handler) — BFS over this endpoint's edges
        dist = {ep.handler_id: 0}
        queue = [ep.handler_id]
        while queue:
            cur = queue.pop(0)
            for nxt in kids.get(cur, ()):
                if nxt not in dist:
                    dist[nxt] = dist[cur] + 1
                    queue.append(nxt)
        for fid, d in dist.items():
            depth[fid] = min(depth.get(fid, d), d)

    # ── classify ─────────────────────────────────────────────────────────
    funcs: dict[str, dict[str, Any]] = {}
    for fid in reached_by:
        f = reg.funcs.get(fid)
        if f is None:
            continue
        m: dict[str, Any] = {
            "fan_in": len(parents[fid]), "fan_out": len(kids[fid]), "io": sorted(io[fid]),
            "endpoints": len(reached_by[fid]), "branches": _branches(f.node),
            "loc": f.end_line - f.line + 1, "private": f.name.startswith("_") and not f.name.startswith("__"),
        }
        is_handler = fid in handlers
        score, reasons = score_function(m)
        if is_handler:
            role, reasons = "main", ["endpoint handler"] + reasons
        elif fid in depends_ids and m["io"]:
            role, reasons = "main", ["dependency with I/O"] + reasons
        elif m["fan_out"] == 0 and not m["io"]:
            role, reasons = "child", ["leaf helper: calls nothing, no I/O"]
        else:
            role = "main" if score >= MAIN_THRESHOLD else "child"
        if fid in overrides and overrides[fid] in ("main", "child"):
            role, reasons = overrides[fid], [f"pinned {overrides[fid]} by override"] + reasons
        funcs[fid] = {
            "id": fid, "name": f.qual.split(".<locals>.")[-1], "qual": f.qual, "module": f.module,
            "file_path": f.file_path, "line": f.line, "end_line": f.end_line, "signature": f.signature,
            "doc": f.doc, "is_async": f.is_async, "layer": layer_of(f.module), "role": role,
            "score": round(score, 1), "reasons": reasons, "metrics": m,
            "depth": depth.get(fid), "endpoints": sorted(reached_by[fid]),
            "unresolved_calls": unresolved.get(fid, 0),
        }

    mains = {fid for fid, d in funcs.items() if d["role"] == "main"}

    # ── collapse edges through child chains ──────────────────────────────
    main_edges: dict[tuple[str, str], dict[str, Any]] = {}
    absorbed: dict[str, list[str]] = defaultdict(list)
    used_by: dict[str, set[str]] = defaultdict(set)
    for src in mains:
        stack = [(c, edge_kind.get((src, c), "call")) for c in kids[src]]
        seen_c: set[str] = set()
        while stack:
            cur, kind = stack.pop()
            if cur in seen_c or cur == src:
                continue
            seen_c.add(cur)
            if cur in mains:
                e = main_edges.setdefault((src, cur), {"from": src, "to": cur, "kind": kind, "via": []})
                continue
            if cur in funcs:
                absorbed[src].append(cur)
                used_by[cur].add(src)
                stack.extend((c, kind) for c in kids[cur])
    # `via` = children that sit between two mains (informational)
    for (src, dst), e in main_edges.items():
        e["via"] = [c for c in absorbed[src] if dst in kids[c]]

    for fid, d in funcs.items():
        if d["role"] == "main":
            d["children"] = sorted(absorbed.get(fid, []))
        else:
            d["used_by"] = sorted(used_by.get(fid, []))
            d["shared"] = len(used_by.get(fid, ())) > 1

    # ── module tree (the hierarchy the map zooms through) ────────────────
    modules: dict[str, dict[str, Any]] = {}
    for fid in mains:
        d = funcs[fid]
        mod = modules.setdefault(d["module"], {
            "module": d["module"], "layer": d["layer"], "file_path": d["file_path"], "functions": [],
        })
        mod["functions"].append(fid)
    for mod in modules.values():
        mod["functions"].sort(key=lambda x: (funcs[x]["line"]))
    reached = set(funcs)
    never = sorted(
        f.id for f in reg.funcs.values() if f.id not in reached and f.parent_id is None and not f.name.startswith("_")
    )

    return {
        "project_path": analysis.routes.project_path,
        "entry_points": _entry_points(analysis),
        "endpoints": [
            {"id": e.id, "method": e.method, "path": e.path, "handler_id": e.handler_id, "summary": e.summary}
            for e in analysis.routes.endpoints
        ],
        "layers": sorted({d["layer"] for d in funcs.values() if d["role"] == "main"}),
        "modules": sorted(modules.values(), key=lambda m: m["module"]),
        "functions": funcs,
        "edges": sorted(main_edges.values(), key=lambda e: (e["from"], e["to"])),
        "unreached": never,
        "stats": {
            "functions": len(funcs), "main": len(mains), "child": len(funcs) - len(mains),
            "edges": len(main_edges), "unreached": len(never),
        },
    }

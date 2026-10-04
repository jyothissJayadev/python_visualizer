"""backend/analysis/telelog_tools.py — what the telelog MCP tools and the edit hook ask of the analysis.

Pure functions over an Analysis (no HTTP): the API layer and the tests call these directly.
Responses are compact on purpose: ids and short fields, source capped, no full-file dumps.
"""

from __future__ import annotations

import os
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable, Iterable

from backend.analysis.callgraph import N
from backend.analysis.mapmodel import _entry_points
from backend.analysis.telelog import (
    ParseResult,
    Tag,
    ValidationReport,
    current_fingerprints,
    read_tags,
    tagged_function_ids,
    validate_tags,
)
from backend.analysis.telelog_store import CallInfo, TelelogStore, call_info

MAX_SOURCE_LINES = 80
MAX_REPORT_ISSUES = 60
ROLE_RANK = {"main": 0, "sub": 1, "helper": 2}


def tag_dict(tag: Tag | None) -> dict[str, Any] | None:
    if tag is None:
        return None
    d = asdict(tag)
    d.pop("bound", None)
    d["problems"] = [asdict(p) for p in tag.problems]
    return d


def _source(analysis, fid: str) -> dict[str, Any]:
    f = analysis.registry.funcs[fid]
    start = min([d.lineno for d in f.node.decorator_list] + [f.line])
    try:
        lines = (Path(analysis.routes.project_path) / f.file_path).read_text(encoding="utf-8").splitlines()
    except OSError:
        return {"text": "", "truncated": False, "start": start}
    chunk = lines[start - 1:f.end_line]
    truncated = len(chunk) > MAX_SOURCE_LINES
    return {"text": "\n".join(chunk[:MAX_SOURCE_LINES]), "truncated": truncated, "start": start}


def get_function(analysis, ids: Iterable[str], parsed: dict[str, ParseResult] | None = None,
                 info: CallInfo | None = None) -> list[dict[str, Any]]:
    """Per id: source (capped), signature, route, callers, callees, tables, existing tag, nearby features."""
    parsed = read_tags(analysis) if parsed is None else parsed
    info = call_info(analysis) if info is None else info
    tags = tagged_function_ids(parsed)
    fps = current_fingerprints(analysis)
    routes: dict[str, list[dict[str, str]]] = {}
    for ep in analysis.routes.endpoints:
        routes.setdefault(ep.handler_id, []).append({"method": ep.method, "path": ep.path})
    out: list[dict[str, Any]] = []
    for fid in ids:
        f = analysis.registry.funcs.get(fid)
        if f is None:
            out.append({"id": fid, "error": "not found"})
            continue
        near = info.callers.get(fid, set()) | info.callees.get(fid, set())
        features = sorted({tags[n].feature for n in near if n in tags and tags[n].feature})
        out.append({
            "id": fid, "file": f.file_path, "line": f.line, "end_line": f.end_line,
            "signature": f.signature, "is_async": f.is_async, "decorators": f.decorators,
            "source": _source(analysis, fid), "route": routes.get(fid, []),
            "callers": sorted(info.callers.get(fid, ())), "callees": sorted(info.callees.get(fid, ())),
            "tables": sorted(info.tables.get(fid, ())), "tag": tag_dict(tags.get(fid)),
            "nearby_features": features, "fingerprint": fps[fid],
        })
    return out


def feature_tree(parsed: dict[str, ParseResult]) -> dict[str, Any]:
    """Existing features with their main functions, so new tags reuse names instead of inventing near-duplicates."""
    feats: dict[str, dict[str, Any]] = {}
    for fid, tag in tagged_function_ids(parsed).items():
        if not tag.feature:
            continue
        f = feats.setdefault(tag.feature, {"name": tag.feature, "functions": 0, "mains": []})
        f["functions"] += 1
        if tag.role == "main":
            f["mains"].append({"id": fid, "purpose": tag.purpose})
    for f in feats.values():
        f["mains"].sort(key=lambda m: m["id"])
    return {"features": sorted(feats.values(), key=lambda f: f["name"])}


def suggest_parent(analysis, fid: str, parsed: dict[str, ParseResult] | None = None,
                   info: CallInfo | None = None, max_depth: int = 4) -> list[dict[str, Any]]:
    """Tagged functions that call this one, nearest first (walking up through untagged callers)."""
    parsed = read_tags(analysis) if parsed is None else parsed
    info = call_info(analysis) if info is None else info
    tags = tagged_function_ids(parsed)
    found: dict[str, int] = {}
    seen = {fid}
    frontier = [fid]
    for depth in range(1, max_depth + 1):
        nxt: list[str] = []
        for cur in frontier:
            for caller in sorted(info.callers.get(cur, ())):
                if caller in seen:
                    continue
                seen.add(caller)
                if caller in tags:
                    found.setdefault(caller, depth)
                else:
                    nxt.append(caller)
        frontier = nxt
        if not frontier:
            break
    ranked = sorted(found, key=lambda c: (found[c], ROLE_RANK.get(tags[c].role or "", 3), c))
    return [{"id": c, "role": tags[c].role, "feature": tags[c].feature, "distance": found[c]} for c in ranked[:5]]


def check_changed(analysis, paths: Iterable[str], verified: dict[str, str],
                  exclude: Callable[[Any], bool] | None = None,
                  parsed: dict[str, ParseResult] | None = None) -> dict[str, Any]:
    """For the edit hook: tagged functions in these files whose body changed since their tag was verified,
    and functions in them with no tag at all."""
    root = os.path.abspath(analysis.routes.project_path)
    wanted: set[str] = set()
    for p in paths:
        full = p if os.path.isabs(p) else os.path.join(root, p)
        wanted.add(os.path.normpath(os.path.relpath(full, root)))
    parsed = read_tags(analysis) if parsed is None else parsed
    tags = tagged_function_ids(parsed)
    fps = current_fingerprints(analysis)
    changed: list[dict[str, Any]] = []
    untagged: list[str] = []
    for fid, f in analysis.registry.funcs.items():
        if os.path.normpath(f.file_path) not in wanted or (exclude is not None and exclude(f)):
            continue
        if fid not in tags:
            untagged.append(fid)
        elif fid in verified and verified[fid] != fps[fid]:
            changed.append({"id": fid, "line": f.line, "reason": "body changed since the tag was last verified"})
    return {"changed": sorted(changed, key=lambda c: c["id"]), "untagged": sorted(untagged)}


def validation_summary(report: ValidationReport) -> dict[str, Any]:
    """Compact validate_tags output: counts per code plus the first issues, errors before warnings."""
    by_code: dict[str, int] = {}
    for i in report.errors + report.warnings:
        by_code[i.code] = by_code.get(i.code, 0) + 1
    issues = [asdict(i) for i in report.errors + report.warnings]
    return {
        "ok": not report.errors, "errors": len(report.errors), "warnings": len(report.warnings),
        "tagged": report.tagged, "functions": report.functions, "by_code": by_code,
        "issues": issues[:MAX_REPORT_ISSUES], "truncated": len(issues) > MAX_REPORT_ISSUES,
    }


def validate(analysis, store: TelelogStore, exclude: Callable[[Any], bool] | None = None) -> dict[str, Any]:
    return validation_summary(validate_tags(analysis, store.verified(), exclude))


def record_progress(analysis, store: TelelogStore, ids: Iterable[str],
                    parsed: dict[str, ParseResult] | None = None) -> dict[str, Any]:
    """Mark ids as handled by the audit; tagged ones also become verified against their current body."""
    ids = list(ids)
    parsed = read_tags(analysis) if parsed is None else parsed
    tags = tagged_function_ids(parsed)
    fps = current_fingerprints(analysis)
    verified_now = {fid: fps[fid] for fid in ids if fid in tags and fid in fps}
    if verified_now:
        store.mark_verified(verified_now)
    progress = store.record_progress(ids)
    return {**progress, "verified": sorted(verified_now), "not_tagged": sorted(set(ids) - set(verified_now))}


def telelog_payload(analysis, parsed: dict[str, ParseResult], verified: dict[str, str],
                    exclude: Callable[[Any], bool] | None = None, info: CallInfo | None = None) -> dict[str, Any]:
    """Everything the Telelog map view draws: features, the parent/step tree, per-function tag + health, and
    the functions still untagged grouped by module (the fallback grouping)."""
    info = call_info(analysis) if info is None else info
    tags = tagged_function_ids(parsed)
    report = validate_tags(analysis, verified, exclude)
    bad: dict[str, str] = {}
    for i in report.warnings:
        if i.id and i.code == "stale":
            bad[i.id] = "stale"
    for i in report.errors:
        if i.id and i.code != "missing-tag":
            bad[i.id] = "invalid"
    routes: dict[str, list[str]] = {}
    endpoints: dict[str, list[dict[str, Any]]] = {}
    for ep in analysis.routes.endpoints:
        routes.setdefault(ep.handler_id, []).append(f"{ep.method} {ep.path}")
        endpoints.setdefault(ep.handler_id, []).append({
            "id": ep.id, "method": ep.method, "path": ep.path, "status_code": ep.status_code,
            "response_model": ep.response_model, "dependencies": ep.dependencies, "summary": ep.summary,
        })
    reg = analysis.registry.funcs
    functions: dict[str, Any] = {}
    for fid, tag in tags.items():
        f = reg.get(fid)
        d = tag_dict(tag) or {}
        d.update({"id": fid, "status": bad.get(fid, "ok"), "tables": sorted(info.tables.get(fid, ())),
                  "routes": routes.get(fid, []), "endpoints": endpoints.get(fid, []), "line": f.line if f else None, "file": f.file_path if f else None,
                  "module": f.module if f else fid.split(":", 1)[0], "signature": f"{f.name}{f.signature}" if f else None})
        functions[fid] = d
    feats: dict[str, dict[str, Any]] = {}
    for fid, d in functions.items():
        name = d["feature"] or "(no feature)"
        ft = feats.setdefault(name, {"name": name, "mains": [], "functions": 0, "endpoints": 0, "tables": set()})
        ft["functions"] += 1
        ft["tables"].update(d["tables"])
        if d["role"] == "main":
            ft["mains"].append(fid)
        if d["routes"]:
            ft["endpoints"] += len(d["routes"])
    for ft in feats.values():
        ft["mains"].sort()
        ft["tables"] = sorted(ft["tables"])
    children: dict[str, list[str]] = {}
    for fid, d in functions.items():
        if d["parent"]:
            children.setdefault(d["parent"], []).append(fid)
    for kids in children.values():
        kids.sort(key=lambda k: (functions[k]["n"] if functions[k]["n"] is not None else 10**6, k))
    untagged: dict[str, list[str]] = {}
    files: dict[str, str] = {}
    for fid, f in reg.items():
        files.setdefault(f.module, f.file_path)
        if fid in tags or (exclude is not None and exclude(f)):
            continue
        untagged.setdefault(f.module, []).append(fid)
    return {
        "features": sorted(feats.values(), key=lambda f: f["name"]),
        "functions": functions,
        "children": children,
        "untagged": {m: sorted(v) for m, v in sorted(untagged.items())},
        "files": files,
        "calls": function_calls(analysis, functions),
        "entry_points": [
            {k: e.get(k) for k in ("id", "kind", "framework", "module", "file_path", "line")} for e in _entry_points(analysis)
        ],
        "endpoint_count": len(analysis.routes.endpoints),
        "coverage": {
            "tagged": len(tags), "total": report.functions,
            "stale": sum(1 for v in bad.values() if v == "stale"),
            "invalid": sum(1 for v in bad.values() if v == "invalid"),
        },
    }


_DISSOLVE = ("loop", "branch", "arm", "graph", "dispatch")


def _direct_callees(nodes: list[N], out: list[N]) -> None:
    """The project functions a function calls itself: control-flow wrappers are looked through, calls made
    further down (by the callees) are not."""
    for n in nodes:
        if n.kind == "function" and n.function_id:
            out.append(n)
        elif n.kind in _DISSOLVE:
            _direct_callees(n.children, out)


def function_calls(analysis, ids: Iterable[str]) -> dict[str, list[dict[str, Any]]]:
    """caller id -> [{to, n, edge}] for direct calls between the given functions (call sites counted)."""
    wanted = set(ids)
    cg = analysis.callgraph
    out: dict[str, list[dict[str, Any]]] = {}
    for fid in sorted(wanted):
        if fid not in analysis.registry.funcs:
            continue
        try:
            kids, _ = cg._expand_function(fid, {}, ())
        except Exception:  # noqa: BLE001 — one unanalysable function must not hide every other connection
            continue
        direct: list[N] = []
        _direct_callees(kids, direct)
        by: dict[str, dict[str, Any]] = {}
        for c in direct:
            cid = c.function_id
            if cid in wanted and cid != fid:
                e = by.setdefault(cid, {"to": cid, "n": 0, "edge": c.edge})
                e["n"] += 1
        if by:
            out[fid] = sorted(by.values(), key=lambda e: e["to"])
    return out


MAX_FLOW_STEPS = 260


def flow_steps(analysis, handler_id: str, max_steps: int = MAX_FLOW_STEPS) -> dict[str, Any] | None:
    """The order things run in when an endpoint is called: its handler, then every function it calls, depth first, in
    the order the calls appear in the source. A function reached a second time is listed again but not re-expanded
    (marked `repeat`), so the walk stays readable. Database access and library calls appear as leaf steps."""
    cg = analysis.callgraph
    ep = next((e for e in analysis.routes.endpoints if e.handler_id == handler_id), None)
    root = cg.endpoint_root(ep) if ep is not None else None
    if root is None and handler_id in analysis.registry.funcs:
        try:
            root = cg._function_node(handler_id, {}, (), set(), "call", None, None)
        except Exception:  # noqa: BLE001
            root = None
    if root is None:
        return None
    steps: list[dict[str, Any]] = []
    expanded: set[str] = set()
    truncated = False

    def add(step: dict[str, Any]) -> int:
        step["i"] = len(steps)
        steps.append(step)
        return step["i"]

    def walk(n: N, depth: int, parent: int | None) -> None:
        nonlocal truncated
        if len(steps) >= max_steps:
            truncated = True
            return
        if n.kind == "function" and n.function_id:
            repeat = n.function_id in expanded or n.cyclic
            i = add({"kind": "fn", "id": n.function_id, "depth": depth, "parent": parent, "edge": n.edge, "line": n.call_line,
                     "expr": n.call_expr, "repeat": repeat, "recursive": bool(n.cyclic)})
            expanded.add(n.function_id)
            if not repeat:
                for c in n.children:
                    walk(c, depth + 1, i)
        elif n.kind in _DISSOLVE:
            for c in n.children:
                walk(c, depth, parent)
        elif n.kind == "db":
            add({"kind": "db", "id": n.name, "depth": depth, "parent": parent, "edge": n.edge, "line": n.call_line,
                 "expr": n.call_expr, "repeat": False, "recursive": False})
        elif n.kind == "external" and n.external:
            add({"kind": "external", "id": n.external, "depth": depth, "parent": parent, "edge": n.edge, "line": n.call_line,
                 "expr": n.call_expr, "repeat": False, "recursive": False})

    walk(root, 0, None)
    return {"handler": handler_id, "route": root.label, "steps": steps, "truncated": truncated}

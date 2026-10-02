"""backend/analysis/algorithm.py — the algorithm card of a function.

"Locked facts, filled prose": the *skeleton* (ordered steps, the functions
they call, branches, loops, raises, returns) comes only from the static call
graph and never changes unless the code does. A *fill* (written by an LLM
agent, or the deterministic fallback below) may only supply a purpose line and
a label / note per existing step id. ``validate_fill`` rejects anything that
would alter the structure, and fills are cached against the function's body
hash, so an unchanged function always renders the same card.

Step ids are index paths ("1", "1.0", "1.0.2") over the skeleton.
"""

from __future__ import annotations

import ast
import hashlib
import json
import re
from pathlib import Path
from typing import Any

from backend.analysis.callgraph import N, _short
from backend.analysis.engine import Analysis
from backend.analysis.flow import CallStep, LoopStep, expr_steps

MAX_PURPOSE = 240
MAX_LABEL = 120
MAX_NOTE = 240
FILL_KEYS = {"function_id", "body_hash", "purpose", "steps"}
STEP_KEYS = {"label", "note"}


def body_hash(analysis: Analysis, function_id: str) -> str | None:
    f = analysis.registry.funcs.get(function_id)
    if f is None:
        return None
    return hashlib.sha1(ast.dump(f.node, include_attributes=False).encode()).hexdigest()[:16]


def _own_nodes(fn: ast.AST):
    stack = list(ast.iter_child_nodes(fn))
    while stack:
        x = stack.pop()
        if isinstance(x, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        yield x
        stack.extend(ast.iter_child_nodes(x))


def _facts(f: Any, children: list[N]) -> dict[str, Any]:
    raises: list[str] = []
    returns = 0
    for x in _own_nodes(f.node):
        if isinstance(x, ast.Raise):
            exc = x.exc
            target = exc.func if isinstance(exc, ast.Call) else exc
            raises.append(ast.unparse(target) if target is not None else "re-raise")
        elif isinstance(x, ast.Return):
            returns += 1
    return {
        "id": f.id, "signature": f.signature, "doc": f.doc, "file_path": f.file_path,
        "line": f.line, "end_line": f.end_line, "is_async": f.is_async,
        "decorators": f.decorators, "returns": returns, "raises": sorted(set(raises)),
    }


def _node_text(n: N) -> str:
    if n.kind == "function":
        verb = {"spawn": "spawn", "depends": "depends on", "callback": "pass as callback"}.get(n.edge)
        if verb == "pass as callback":
            return f"pass {n.name} as callback"
        return f"{verb} {n.name}" if verb else f"{'await ' if n.edge == 'await' else ''}call {n.name}"
    if n.kind == "db":
        return f"database {n.meta.get('op', 'access')}: {n.name}"
    if n.kind == "class":
        return f"create {n.name}"
    if n.kind == "unresolved":
        return f"call {n.name} (unresolved)"
    return f"call {n.name}"


def _leaf(kind: str, text: str, line: int | None, ref: str | None = None, **extra: Any) -> dict[str, Any]:
    return {"id": "", "kind": kind, "ref": ref, "text": text, "line": line, **extra, "children": []}


def _resolved_lookup(nodes: list[N]) -> dict[tuple[int, str], list[N]]:
    """(call line, call text) -> the resolved nodes, looking through the
    loop / branch / arm markers the call graph wraps them in."""
    out: dict[tuple[int, str], list[N]] = {}
    for n in nodes:
        if n.kind in ("loop", "branch", "arm"):
            for k, v in _resolved_lookup(n.children).items():
                out.setdefault(k, []).extend(v)
        elif n.call_line is not None and n.call_expr is not None:
            out.setdefault((n.call_line, n.call_expr), []).append(n)
    return out


class _Builder:
    def __init__(self, kids: list[N]):
        self.lookup = _resolved_lookup(kids)

    def calls(self, expr: ast.AST | None) -> list[dict[str, Any]]:
        steps: list[Any] = []
        expr_steps(expr, steps)
        out: list[dict[str, Any]] = []
        for st in steps:
            out.extend(self._flow_step(st))
        return out

    def _flow_step(self, st: Any) -> list[dict[str, Any]]:
        if isinstance(st, CallStep):
            nodes = self.lookup.get((st.call.lineno, _short(ast.unparse(st.call))), [])
            return [self._from_node(n) for n in nodes]
        if isinstance(st, LoopStep):  # comprehension
            inner = [x for s in st.body for x in self._flow_step(s)]
            return [{**_leaf("loop", st.header, st.line), "children": inner}] if inner else []
        return []

    def _from_node(self, n: N) -> dict[str, Any]:
        extra: dict[str, Any] = {}
        if n.meta.get("count"):
            extra["count"] = n.meta["count"]
        if n.cyclic:
            extra["recursive"] = True
        return _leaf(n.kind, _node_text(n), n.call_line, n.function_id or n.external, **extra)

    def body(self, stmts: list[ast.stmt]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for st in stmts:
            out.extend(self.stmt(st))
        return out

    def stmt(self, st: ast.stmt) -> list[dict[str, Any]]:
        if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            return []
        if isinstance(st, ast.If):
            arms: list[dict[str, Any]] = []
            cur: ast.stmt | None = st
            pre = self.calls(st.test)
            first = True
            while isinstance(cur, ast.If):
                label = ("if " if first else "elif ") + _short(ast.unparse(cur.test))
                arms.append({**_leaf("arm", label, cur.lineno), "children": self.body(cur.body)})
                first = False
                orelse = cur.orelse
                if len(orelse) == 1 and isinstance(orelse[0], ast.If):
                    cur = orelse[0]
                    continue
                if orelse:
                    arms.append({**_leaf("arm", "else", orelse[0].lineno), "children": self.body(orelse)})
                break
            if not any(a["children"] for a in arms):
                return pre
            return pre + [{**_leaf("branch", f"decision: {_short(ast.unparse(st.test))}", st.lineno), "children": arms}]
        if isinstance(st, (ast.For, ast.AsyncFor)):
            pre = self.calls(st.iter)
            inner = self.body(st.body) + self.body(st.orelse)
            head = _short(f"{'async ' if isinstance(st, ast.AsyncFor) else ''}for {ast.unparse(st.target)} in {ast.unparse(st.iter)}")
            return pre + ([{**_leaf("loop", head, st.lineno), "children": inner}] if inner else [])
        if isinstance(st, ast.While):
            inner = self.calls(st.test) + self.body(st.body) + self.body(st.orelse)
            return [{**_leaf("loop", _short(f"while {ast.unparse(st.test)}"), st.lineno), "children": inner}] if inner else []
        if isinstance(st, (ast.Try, getattr(ast, "TryStar", ast.Try))):
            arms = [{**_leaf("arm", "try", st.lineno), "children": self.body(st.body)}]
            for h in st.handlers:
                label = f"except {ast.unparse(h.type)}" if h.type is not None else "except"
                arms.append({**_leaf("arm", _short(label), h.lineno), "children": self.body(h.body)})
            if st.orelse:
                arms.append({**_leaf("arm", "else", st.orelse[0].lineno), "children": self.body(st.orelse)})
            if st.finalbody:
                arms.append({**_leaf("arm", "finally", st.finalbody[0].lineno), "children": self.body(st.finalbody)})
            if not any(a["children"] for a in arms):
                return []
            return [{**_leaf("branch", "try / except", st.lineno), "children": arms}]
        if isinstance(st, (ast.With, ast.AsyncWith)):
            out: list[dict[str, Any]] = []
            for item in st.items:
                out.extend(self.calls(item.context_expr))
            return out + self.body(st.body)
        if isinstance(st, ast.Match):
            arms = [
                {**_leaf("arm", _short(f"case {ast.unparse(c.pattern)}"), c.pattern.lineno), "children": self.body(c.body)}
                for c in st.cases
            ]
            pre = self.calls(st.subject)
            if not any(a["children"] for a in arms):
                return pre
            return pre + [{**_leaf("branch", f"match {_short(ast.unparse(st.subject))}", st.lineno), "children": arms}]
        if isinstance(st, ast.Raise):
            target = st.exc.func if isinstance(st.exc, ast.Call) else st.exc
            text = f"raise {ast.unparse(target)}" if target is not None else "re-raise"
            return self.calls(st.exc) + [_leaf("raise", text, st.lineno)]
        if isinstance(st, ast.Return):
            value = _short(ast.unparse(st.value)) if st.value is not None else "None"
            return self.calls(st.value) + [_leaf("return", f"return {value}", st.lineno)]
        out = []
        for child in ast.iter_child_nodes(st):
            out.extend(self.calls(child))
        return out


def _number(steps: list[dict[str, Any]], prefix: str = "") -> list[dict[str, Any]]:
    for i, s in enumerate(steps):
        s["id"] = f"{prefix}{i}"
        _number(s["children"], f"{s['id']}.")
    return steps


def _build_steps(f: Any, kids: list[N]) -> list[dict[str, Any]]:
    b = _Builder(kids)
    steps = [_from_dep(n) for n in kids if n.edge == "depends"]
    steps += b.body(f.node.body)
    claimed = {id(n) for v in b.lookup.values() for n in v}
    # callbacks handed to create_task / gather ... carry no call line
    steps += [b._from_node(n) for n in kids if n.edge == "callback" and id(n) not in claimed]
    return _number(steps)


def _from_dep(n: N) -> dict[str, Any]:
    return _leaf(n.kind, _node_text(n), n.call_line, n.function_id or n.external)


def skeleton(analysis: Analysis, function_id: str) -> dict[str, Any] | None:
    f = analysis.registry.funcs.get(function_id)
    if f is None:
        return None
    kids, _ = analysis.callgraph._expand_function(function_id, {}, ())
    return {
        "function_id": function_id,
        "body_hash": body_hash(analysis, function_id),
        "facts": _facts(f, kids),
        "steps": _build_steps(f, kids),
    }


def _all_ids(steps: list[dict[str, Any]]) -> list[str]:
    ids: list[str] = []
    for s in steps:
        ids.append(s["id"])
        ids.extend(_all_ids(s["children"]))
    return ids


def validate_fill(skel: dict[str, Any], fill: Any) -> list[str]:
    """Problems with a fill (empty list = acceptable)."""
    if not isinstance(fill, dict):
        return ["fill must be an object"]
    problems: list[str] = []
    extra = set(fill) - FILL_KEYS
    if extra:
        problems.append(f"unknown keys: {sorted(extra)}")
    if fill.get("function_id") != skel["function_id"]:
        problems.append("function_id does not match")
    if fill.get("body_hash") != skel["body_hash"]:
        problems.append("body_hash does not match the current code (stale fill)")
    purpose = fill.get("purpose", "")
    if not isinstance(purpose, str) or len(purpose) > MAX_PURPOSE:
        problems.append(f"purpose must be text up to {MAX_PURPOSE} characters")
    steps = fill.get("steps", {})
    if not isinstance(steps, dict):
        return problems + ["steps must be an object keyed by step id"]
    known = set(_all_ids(skel["steps"]))
    for sid, entry in steps.items():
        if sid not in known:
            problems.append(f"unknown step id {sid!r} (the structure is locked)")
            continue
        if not isinstance(entry, dict) or set(entry) - STEP_KEYS:
            problems.append(f"step {sid}: only label / note are allowed")
            continue
        for key, limit in (("label", MAX_LABEL), ("note", MAX_NOTE)):
            v = entry.get(key)
            if v is not None and (not isinstance(v, str) or len(v) > limit):
                problems.append(f"step {sid}: {key} must be text up to {limit} characters")
    return problems


def _merge(steps: list[dict[str, Any]], fill_steps: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for s in steps:
        entry = fill_steps.get(s["id"], {})
        merged = dict(s)
        merged["label"] = entry.get("label") or s["text"]
        if entry.get("note"):
            merged["note"] = entry["note"]
        merged["children"] = _merge(s["children"], fill_steps)
        out.append(merged)
    return out


def card(skel: dict[str, Any], fill: dict[str, Any] | None, fill_status: str) -> dict[str, Any]:
    """Skeleton + (valid) fill -> the card the map shows. Facts and step
    structure are always the skeleton's."""
    use = fill if fill is not None and not validate_fill(skel, fill) else None
    status = fill_status if use is not None else ("stale" if fill is not None else "deterministic")
    doc = skel["facts"].get("doc")
    purpose = (use or {}).get("purpose") or doc or ""
    return {
        "function_id": skel["function_id"], "body_hash": skel["body_hash"], "facts": skel["facts"],
        "purpose": purpose, "fill_status": status,
        "steps": _merge(skel["steps"], (use or {}).get("steps", {})),
    }


class AlgorithmStore:
    """Fills cached on disk, one file per function (in *this* repo's .cache,
    never in the target project)."""

    def __init__(self, directory: Path):
        self.directory = directory

    def _file(self, function_id: str) -> Path:
        safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", function_id)
        return self.directory / f"{safe}.json"

    def get(self, function_id: str) -> dict[str, Any] | None:
        p = self._file(function_id)
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def put(self, skel: dict[str, Any], fill: dict[str, Any]) -> list[str]:
        problems = validate_fill(skel, fill)
        if problems:
            return problems
        self.directory.mkdir(parents=True, exist_ok=True)
        self._file(skel["function_id"]).write_text(json.dumps(fill, indent=2), encoding="utf-8")
        return []

    def card(self, analysis: Analysis, function_id: str) -> dict[str, Any] | None:
        skel = skeleton(analysis, function_id)
        if skel is None:
            return None
        return card(skel, self.get(function_id), "filled")

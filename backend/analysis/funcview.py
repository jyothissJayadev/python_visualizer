"""backend/analysis/funcview.py — the "functions only" view of a call tree.

The full tree (callgraph.py) also carries loop / branch / try markers,
Protocol-dispatch and LangGraph wrappers, library calls, class
instantiations and unresolved calls. The Routes view shows only the
project's own functions, so this derives that view:

  * control-flow markers, dispatch and graph wrappers are dissolved — their
    function children move up to the enclosing function
  * library / built-in calls, class instantiations and unresolved calls are
    not shown as nodes; they are attached to the calling function as
    ``meta["library"]`` (a de-duplicated list) for the details panel
  * a function called several times from the same parent appears once, with
    ``meta["count"]`` = number of call sites
  * database access becomes ``meta["data"]``: the tables the function itself
    reads / writes (``uncertain`` = one of several possible labels,
    ``unattributed`` = a database call that could not be tied to a table), and
    ``meta["below"]`` = the tables reached by anything it calls

Shared subtrees stay shared (memoised by node identity), so this is linear in
the size of the underlying graph, not in the size of the expanded tree.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from backend.analysis.callgraph import N, tree_stats

LIBRARY_KINDS = ("external", "class", "unresolved")
_KIND_ORDER = {k: i for i, k in enumerate(LIBRARY_KINDS)}
MAX_LIBRARY_ENTRIES = 80
NEO4J_VIA = {"run", "execute_read", "execute_write"}


def function_view(root: N) -> N:
    memo: dict[int, N] = {}

    def convert(n: N) -> N:
        done = memo.get(id(n))
        if done is not None:
            return done
        found: list[N] = []
        library: dict[tuple[str, str], dict[str, Any]] = {}
        data: dict[tuple[str, str, bool], dict[str, Any]] = {}
        collect(n.children, found, library, data)
        # `session.run(...)` in a function that also contains Cypher is that
        # function's own query being executed — not a separate unknown call
        if any(e["table"] != "?" or not e.get("via") for e in data.values() if e.get("engine") == "neo4j"):
            data = {k: e for k, e in data.items() if not (e.get("via") in NEO4J_VIA and e["table"] == "?")}

        by_id: dict[str, list[N]] = {}
        for child in found:
            by_id.setdefault(child.function_id or child.name, []).append(child)
        kids: list[N] = []
        for group in by_id.values():
            first = group[0]
            kids.append(replace(first, meta={**first.meta, "count": len(group)}) if len(group) > 1 else first)

        meta = {k: v for k, v in n.meta.items() if k not in ("count", "graph", "library", "data", "below", "below_count")}
        if data:
            meta["data"] = [
                {
                    k: (list(v.values()) if k == "fields" else v)
                    for k, v in e.items()
                    if k != "engine" and not (k == "uncertain" and not v) and not (k == "fields" and not v)
                }
                for e in sorted(data.values(), key=lambda e: (e["table"], e["op"]))
            ]
        own = {e["table"] for e in data.values() if e["table"] != "?"}
        below: set[str] = set()
        for kid in kids:
            below |= tables_of(kid)
        below -= own
        if below:
            meta["below"] = sorted(below)
            meta["below_count"] = len(below)
        if n.meta.get("graph"):
            meta["graph"] = n.meta["graph"]
        if library:
            ordered = sorted(library.values(), key=lambda e: (_KIND_ORDER[e["kind"]], e["name"]))
            meta["library"] = ordered[:MAX_LIBRARY_ENTRIES]
            if len(ordered) > MAX_LIBRARY_ENTRIES:
                meta["library_more"] = len(ordered) - MAX_LIBRARY_ENTRIES
        out = replace(n, kind="function", children=kids, meta=meta)
        memo[id(n)] = out
        return out

    below_memo: dict[int, frozenset[str]] = {}

    def tables_of(n: N) -> frozenset[str]:
        """Every real table touched by `n` or anything below it."""
        got = below_memo.get(id(n))
        if got is not None:
            return got
        acc = {e["table"] for e in n.meta.get("data", []) if e["table"] != "?"}
        acc |= set(n.meta.get("below", ()))
        result = frozenset(acc)
        below_memo[id(n)] = result
        return result

    def collect(
        children: list[N], kids: list[N], library: dict[tuple[str, str], dict[str, Any]],
        data: dict[tuple[str, str, bool], dict[str, Any]],
    ) -> None:
        for c in children:
            if c.kind == "function":
                kids.append(convert(c))
            elif c.kind == "db":
                table = c.external or "?"
                op = c.meta.get("op", "read")
                unattributed = bool(c.meta.get("unattributed"))
                entry = data.get((table, op, unattributed))
                if entry is None:
                    entry = data[(table, op, unattributed)] = {"table": table, "op": op, "count": 0, "engine": c.meta.get("engine"), "fields": {}}
                    if unattributed:
                        entry["unattributed"] = True
                        for k, v in (("via", c.meta.get("via")), ("expr", c.call_expr), ("line", c.call_line), ("reason", c.meta.get("reason"))):
                            if v:
                                entry[k] = v
                    entry["uncertain"] = bool(c.meta.get("uncertain"))
                else:
                    entry["uncertain"] = entry["uncertain"] and bool(c.meta.get("uncertain"))
                entry["count"] += c.meta.get("count", 1)
                for f in c.meta.get("fields", ()):  # inferred columns / properties
                    entry["fields"].setdefault(f["name"], f)
            elif c.kind in LIBRARY_KINDS:
                if c.kind == "external":
                    name = c.external or c.name
                elif c.kind == "class":
                    name = c.name  # "Plain()" — not the whole call with its arguments
                else:
                    name = c.call_expr or c.name
                entry = library.setdefault(
                    (c.kind, name), {"kind": c.kind, "name": name, "count": 0, "line": c.call_line}
                )
                entry["count"] += c.meta.get("count", 1)
                if c.kind == "unresolved" and c.meta.get("reason"):
                    entry["reason"] = c.meta["reason"]
            else:  # loop / branch / arm / dispatch / graph: look through
                collect(c.children, kids, library, data)

    return convert(root)


def view_stats(full: N, view: N) -> dict[str, Any]:
    """Counts for the header: function/depth from the view, library and
    resolution numbers from the full tree (the view hides those nodes)."""
    f = tree_stats(full)
    v = tree_stats(view)
    return {
        "function": v["function"],
        "max_depth": v["max_depth"],
        "cyclic": v["cyclic"],
        "nodes": v["function"],
        "external": f["external"],
        "class": f["class"],
        "unresolved": f["unresolved"],
        "graph": f["graph"],
        "coverage": f["coverage"],
    }


_DB_OF_PREFIX = {"mongo": "mongodb", "neo4j": "neo4j", "neo4j-rel": "neo4j"}
_KIND_OF_PREFIX = {"mongo": "collection", "neo4j": "label", "neo4j-rel": "relationship"}


def data_summary(root: N) -> dict[str, Any]:
    """What an endpoint does to the database, from a *function view*:

    ``tables`` — every table touched, with operations and the functions
    responsible (each with the index path of its first appearance in the
    hierarchy, for "show in tree"); ``uncertain`` marks tables that are only
    one of several possible labels.

    ``audit`` — coverage: how many functions touch the database, and which of
    them do so through a call that could not be tied to a table.
    """
    tables: dict[str, dict[str, Any]] = {}
    unmatched: list[dict[str, Any]] = []
    with_db = 0
    seen: set[int] = set()

    def walk(n: N, path: str, chain: tuple[str, ...]) -> None:
        nonlocal with_db
        if id(n) in seen:
            return
        seen.add(id(n))
        chain = chain + (n.name,)
        entries = n.meta.get("data", [])
        if entries:
            with_db += 1
        for entry in entries:
            if entry["table"] == "?":
                unmatched.append({
                    "function_id": n.function_id, "name": n.name, "path": path, "op": entry["op"],
                    "via": entry.get("via"), "expr": entry.get("expr"), "line": entry.get("line"),
                    "reason": entry.get("reason"), "count": entry["count"],
                })
                continue
            prefix, _, name = entry["table"].partition(":")
            t = tables.setdefault(entry["table"], {
                "table": entry["table"], "database": _DB_OF_PREFIX.get(prefix, prefix),
                "kind": _KIND_OF_PREFIX.get(prefix, "collection"), "name": name, "ops": {},
                "functions": {}, "uncertain": True, "fields": {},
            })
            for f in entry.get("fields", ()):
                t["fields"].setdefault(f["name"], f)
            t["ops"][entry["op"]] = t["ops"].get(entry["op"], 0) + entry["count"]
            uncertain = bool(entry.get("uncertain"))
            t["uncertain"] = t["uncertain"] and uncertain
            key = (n.function_id or n.name, entry["op"])
            fn = t["functions"].setdefault(key, {
                "function_id": n.function_id, "name": n.name, "op": entry["op"], "count": 0, "path": path,
                "uncertain": uncertain, "chain": list(chain),
            })
            fn["count"] += entry["count"]
        for i, c in enumerate(n.children):
            walk(c, f"{path}.{i}", chain)

    walk(root, "0", ())
    out = []
    for t in tables.values():
        t["functions"] = sorted(t["functions"].values(), key=lambda f: (f["op"], f["name"]))
        t["fields"] = list(t["fields"].values())
        out.append(t)
    out.sort(key=lambda t: (-len(t["functions"]), t["table"]))
    unmatched_fns = {(u["function_id"], u["path"]) for u in unmatched}
    return {
        "tables": out,
        "audit": {
            "functions": with_db,
            "matched": with_db - len(unmatched_fns),
            "unmatched": unmatched,
        },
    }

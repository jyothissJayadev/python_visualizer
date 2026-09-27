"""backend/analysis/relations.py — the connections between tables, from the code.

Two kinds, kept apart because they are not equally certain:

  * **exact** — Neo4j edges the Cypher states outright:
    ``(a:Concept)-[:IS_A]->(b:Concept)``  =>  Concept --IS_A--> Concept
  * **inferred** — Mongo references guessed from field names: a field such as
    ``quotation_id`` / ``winner_node_id`` in one table, and exactly one other
    table whose name says it holds those entities (``quotation_quotations``,
    ``KNode``). A guess that could point at two tables is dropped, not made.
"""

from __future__ import annotations

import re
from typing import Any

_DOMAIN_PREFIXES = ("quotation_", "execution_", "core_")
_NOISE_PREFIXES = ("ext_",)


def _snake(name: str) -> str:
    return re.sub(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", "_", name).lower()


def _singular(word: str) -> str:
    if word.endswith("ies") and len(word) > 4:
        return word[:-3] + "y"
    if word.endswith("sses"):
        return word[:-2]
    if word.endswith("s") and not word.endswith("ss") and len(word) > 3:
        return word[:-1]
    return word


def entity_aliases(table: dict[str, Any]) -> dict[str, int]:
    """Names a foreign-key field may use for the entities this table holds,
    best (0) to weakest (2): `quotation_quotations` -> {quotation: 0};
    `ChatSession` -> {chat_session: 0, session: 1, chat: 2}."""
    name = _snake(table["name"])
    for prefix in _DOMAIN_PREFIXES:
        if name.startswith(prefix):
            name = name[len(prefix):]
            break
    for prefix in _NOISE_PREFIXES:
        if name.startswith(prefix):
            name = name[len(prefix):]
    parts = [p for p in name.split("_") if p]
    if not parts:
        return {}
    out = {_singular("_".join(parts)): 0}
    out.setdefault(_singular(parts[-1]), 1)
    out.setdefault(_singular(parts[0]), 2)
    return out


def _reference_stems(field: str) -> list[str]:
    """`winner_node_id` -> ["winner_node", "node"]; only *_id / *_ids fields qualify."""
    m = re.fullmatch(r"(.+?)_ids?", field)
    if not m:
        return []
    tokens = m.group(1).split("_")
    return ["_".join(tokens[k:]) for k in range(len(tokens))]


def neo4j_edges(tables: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Exact edges, one per (from label, relationship type, to label)."""
    out: list[dict[str, Any]] = []
    for t in tables:
        for e in t.get("edges", ()):
            out.append({
                "id": f'{e["from"]}-[{t["name"]}]->{e["to"]}',
                "from": e["from"], "to": e["to"], "type": "neo4j_edge", "label": t["name"],
                "confidence": "exact", "uncertain": bool(e.get("uncertain")), "fields": [],
                "evidence": [{"function_id": f["function_id"], "name": f["name"]} for f in t["functions"]][:6],
            })
    return out


def mongo_references(tables: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Inferred references from Mongo tables to the tables their id-fields name."""
    targets = [t for t in tables if t["kind"] != "relationship"]
    alias_of = {t["table"]: entity_aliases(t) for t in targets}
    found: dict[tuple[str, str], dict[str, Any]] = {}
    for src in tables:
        if src["database"] != "mongodb":
            continue
        for f in src["fields"]:
            best: tuple[int, list[dict[str, Any]]] | None = None
            for stem in _reference_stems(f["name"]):
                hits = [(alias_of[t["table"]][stem], t) for t in targets if t["table"] != src["table"] and stem in alias_of[t["table"]]]
                if not hits:
                    continue
                rank = min(h[0] for h in hits)
                cands = [t for r, t in hits if r == rank]
                best = (rank, cands)
                break  # the longest matching stem wins
            if best is None:
                continue
            cands = best[1]
            if len(cands) > 1:  # ambiguous: prefer the same domain, else drop the guess
                same = [c for c in cands if _domain(c) == _domain(src)]
                cands = same if len(same) == 1 else []
            if len(cands) != 1:
                continue
            dst = cands[0]
            rec = found.setdefault((src["table"], dst["table"]), {
                "id": f'{src["table"]}->{dst["table"]}', "from": src["table"], "to": dst["table"],
                "type": "mongo_fk" if dst["database"] == "mongodb" else "cross_database",
                "label": "", "confidence": "inferred", "uncertain": False, "fields": [], "evidence": [],
            })
            rec["fields"].append(f["name"])
    for rec in found.values():
        rec["fields"] = sorted(set(rec["fields"]))
        rec["label"] = ", ".join(rec["fields"][:2]) + (" …" if len(rec["fields"]) > 2 else "")
    return list(found.values())


def _domain(table: dict[str, Any]) -> str:
    name = table["name"]
    for d in ("quotation", "execution"):
        if name.startswith(d + "_"):
            return d
    return "other"

"""backend/analysis/cypher.py — what a Cypher query touches, read off its text.

Works on a *resolved* query string in which any placeholder whose value could
not be determined statically has been replaced by ``UNKNOWN`` (see
callgraph.CallGraph.str_templates). Extracts:

  * node labels        ``(n:Concept)``, ``(:A:B)``  -> Concept / A, B
  * relationship types ``[r:IS_A]``, ``[:A|B]``     -> IS_A / A, B
  * whether a label or relationship type was left unknown (dynamic)
  * whether the query writes (MERGE / CREATE / SET / DELETE / REMOVE) or reads
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

UNKNOWN = "\x00"

_CYPHER_RX = re.compile(r"\b(MATCH|MERGE|CREATE|CALL|UNWIND)\b")
_WRITE_RX = re.compile(r"\b(MERGE|CREATE|SET|DELETE|REMOVE)\b", re.I)
# a node pattern: "(" [variable] one or more ":Label" ... — the label group is captured whole
_NODE_RX = re.compile(r"\(\s*\w*((?:\s*:\s*(?:`[^`]+`|\w+|\x00))+)")
# a node pattern with its variable, label group and optional property map
_NODE_FULL_RX = re.compile(r"\(\s*(\w*)((?:\s*:\s*(?:`[^`]+`|\w+|\x00))+)\s*(\{[^{}]*\})?")
_REL_FULL_RX = re.compile(r"\[\s*(\w*)\s*:\s*((?:`[^`]+`|\w+|\x00)(?:\s*\|\s*:?\s*(?:`[^`]+`|\w+|\x00))*)\s*(\{[^{}]*\})?")
_MAP_KEY_RX = re.compile(r"(\w+)\s*:")
_ACCESS_RX = re.compile(r"\b(\w+)\.(\w+)\b")
# a relationship pattern: "[" [variable] ":TYPE" ("|" ":"? TYPE)* — captured whole
_REL_RX = re.compile(r"\[\s*\w*\s*:\s*((?:`[^`]+`|\w+|\x00)(?:\s*\|\s*:?\s*(?:`[^`]+`|\w+|\x00))*)")
_NAME_RX = re.compile(r"`([^`]+)`|(\w+|\x00)")


@dataclass
class CypherFacts:
    op: str = "read"
    labels: set[str] = field(default_factory=set)
    rels: set[str] = field(default_factory=set)
    dynamic_label: bool = False
    dynamic_rel: bool = False
    #: property names seen per node label / relationship type: `(n:L {a: $a})`, `n.b`
    label_props: dict[str, set[str]] = field(default_factory=dict)
    rel_props: dict[str, set[str]] = field(default_factory=dict)


def looks_like_cypher(text: str) -> bool:
    return "(" in text and _CYPHER_RX.search(text) is not None


def _names(group: str) -> list[str]:
    return [a or b for a, b in _NAME_RX.findall(group)]


def extract(text: str) -> CypherFacts:
    facts = CypherFacts(op="write" if _WRITE_RX.search(text) else "read")
    for m in _NODE_RX.finditer(text):
        for name in _names(m.group(1)):
            if name == UNKNOWN:
                facts.dynamic_label = True
            elif name[:1].isupper():  # labels are CamelCase; lowercase words are variables / functions
                facts.labels.add(name)
    for m in _REL_RX.finditer(text):
        for name in _names(m.group(1)):
            if name == UNKNOWN:
                facts.dynamic_rel = True
            elif name.isupper() or "_" in name:  # relationship types are UPPER_SNAKE by convention
                facts.rels.add(name)
    _collect_props(text, facts)
    return facts


def _collect_props(text: str, facts: CypherFacts) -> None:
    """Which properties each label / relationship type is used with, from the
    property maps in the pattern and from `variable.property` accesses."""
    var_labels: dict[str, set[str]] = {}
    var_rels: dict[str, set[str]] = {}
    for m in _NODE_FULL_RX.finditer(text):
        var, group, props = m.group(1), m.group(2), m.group(3)
        labels = {n for n in _names(group) if n != UNKNOWN and n[:1].isupper()}
        for label in labels:
            bucket = facts.label_props.setdefault(label, set())
            if props:
                bucket.update(k for k in _MAP_KEY_RX.findall(props) if not k.isdigit())
        if var and labels:
            var_labels.setdefault(var, set()).update(labels)
    for m in _REL_FULL_RX.finditer(text):
        var, group, props = m.group(1), m.group(2), m.group(3)
        types = {n for n in _names(group) if n != UNKNOWN and (n.isupper() or "_" in n)}
        for t in types:
            bucket = facts.rel_props.setdefault(t, set())
            if props:
                bucket.update(k for k in _MAP_KEY_RX.findall(props) if not k.isdigit())
        if var and types:
            var_rels.setdefault(var, set()).update(types)
    for var, prop in _ACCESS_RX.findall(text):
        for label in var_labels.get(var, ()):
            facts.label_props.setdefault(label, set()).add(prop)
        for t in var_rels.get(var, ()):
            facts.rel_props.setdefault(t, set()).add(prop)

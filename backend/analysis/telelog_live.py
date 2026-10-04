"""backend/analysis/telelog_live.py — live sample values for a tag's declared fields.

The detail panel shows only what a tag declares (`in:` / `out:`), filled from the function's newest traced
call. Matching is by name: an input matches an argument of that name (`cart.items` -> argument `cart`, key
`items`), an output matches a key of the result (or the whole result when exactly one output is declared).
Anything that does not match says `no-sample`; a value that may be a secret says `redacted` and its value is
never sent. Redaction happens here, on the server, so a client can never receive a secret.

Event shape (fn.start / fn.end spans, see overlay.py): data.name is the function id, data.args the call's
arguments (a dict by name, or a list in parameter order, or a JSON/repr string), data.result the return value.
"""

from __future__ import annotations

import ast
import json
import re
from typing import Any

PREVIEW_CHARS = 200
SENSITIVE_SOURCES = ("JWT", "header")
SENSITIVE_NAME = re.compile(
    r"pass(word|wd)?|secret|token|authorization|auth|cookie|session|credential|api[_-]?key|private|jwt|bearer|"
    r"card|cvv|cvc|ssn|iban|pin", re.IGNORECASE)


def _as_value(raw: Any) -> Any:
    """A JSON-ish value from a trace payload; strings are parsed when they hold JSON or a Python literal."""
    if isinstance(raw, str):
        for parse in (json.loads, ast.literal_eval):
            try:
                return parse(raw)
            except (ValueError, SyntaxError):
                continue
    return raw


def _lookup(container: Any, path: list[str]) -> tuple[bool, Any]:
    cur = container
    for key in path:
        if isinstance(cur, dict) and key in cur:
            cur = cur[key]
        elif isinstance(cur, (list, tuple)) and key.isdigit() and int(key) < len(cur):
            cur = cur[int(key)]
        else:
            return False, None
    return True, cur


def _preview(value: Any) -> str:
    try:
        text = json.dumps(value, default=str, ensure_ascii=False)
    except (TypeError, ValueError):
        text = str(value)
    return text if len(text) <= PREVIEW_CHARS else text[: PREVIEW_CHARS - 1] + "…"


def is_sensitive(name: str, source: str | None) -> bool:
    if source and any(w.strip() in SENSITIVE_SOURCES for w in source.split(",")):
        return True
    return bool(SENSITIVE_NAME.search(name))


def _args_by_name(args: Any, params: list[str]) -> Any:
    args = _as_value(args)
    if isinstance(args, (list, tuple)):
        names = [p for p in params if p not in ("self", "cls")]
        return {n: v for n, v in zip(names, args)}
    return args


def _field_state(name: str, source: str | None, container: Any) -> dict[str, Any]:
    if is_sensitive(name, source):
        return {"state": "redacted"}
    found, value = _lookup(container, name.split("."))
    return {"state": "sample", "value": _preview(value)} if found else {"state": "no-sample"}


def last_call(events: list[dict[str, Any]], fid: str) -> dict[str, Any] | None:
    """The newest span of `fid`: its start args and (when it finished) result."""
    start = next((e for e in reversed(events) if e.get("kind") == "fn.start" and (e.get("data") or {}).get("name") == fid), None)
    if start is None:
        return None
    end = next((e for e in reversed(events) if e.get("kind") == "fn.end" and e.get("span_id") == start.get("span_id")
                and e.get("request_id") == start.get("request_id")), None)
    return {"request_id": start.get("request_id"), "span_id": start.get("span_id"), "ts": start.get("ts"),
            "args": (start.get("data") or {}).get("args"), "result": ((end or {}).get("data") or {}).get("result"),
            "finished": end is not None}


def live_values(events: list[dict[str, Any]], fid: str, tag: Any, params: list[str]) -> dict[str, Any]:
    """Declared fields of `tag` with sample values from the newest traced call of `fid`."""
    call = last_call(events, fid)
    if call is None or tag is None:
        return {"status": "no-trace", "inputs": {}, "outputs": {}}
    args = _args_by_name(call["args"], params)
    result = _as_value(call["result"]) if call["finished"] else None
    inputs = {f.name: _field_state(f.name, f.source, args) for f in tag.inputs or []}
    outputs: dict[str, Any] = {}
    outs = tag.outputs or []
    for f in outs:
        if not call["finished"]:
            outputs[f.name] = {"state": "no-sample"}
        elif len(outs) == 1 and not isinstance(result, dict):
            outputs[f.name] = ({"state": "redacted"} if is_sensitive(f.name, f.source)
                               else {"state": "sample", "value": _preview(result)})
        else:
            outputs[f.name] = _field_state(f.name, f.source, result)
    return {"status": "ok", "request_id": call["request_id"], "ts": call["ts"], "inputs": inputs, "outputs": outputs}

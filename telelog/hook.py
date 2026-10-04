#!/usr/bin/env python3
"""telelog edit hook — a Claude Code PostToolUse hook for Edit / Write / MultiEdit.

After a Python file is edited it asks the visualizer's collector which tagged functions in that file changed
since their tag was last verified, and which functions have no tag. If there are any it tells Claude to refresh
just those tags. It never blocks and never fails loudly: no collector, no `.py` file, nothing to report -> silent.

Collector URL: $BRAIN_COLLECTOR_URL, else the instance in instances.json whose project or workspace contains
the working directory. Stdlib only, so it runs with the system python3 in any target project.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, TextIO

DEFAULT_INSTANCES = Path(__file__).resolve().parent.parent / "instances.json"
TIMEOUT = 3.0
MAX_LISTED = 12


def resolve_url(env: dict[str, str], cwd: str, instances_path: Path = DEFAULT_INSTANCES) -> str | None:
    if env.get("BRAIN_COLLECTOR_URL"):
        return env["BRAIN_COLLECTOR_URL"].rstrip("/")
    path = Path(env.get("TELELOG_INSTANCES", instances_path))
    try:
        instances = json.loads(path.read_text(encoding="utf-8"))["instances"]
    except (OSError, ValueError, KeyError):
        return None
    here = os.path.abspath(cwd)
    best: tuple[int, int] | None = None
    for inst in instances:
        for root in (inst.get("project"), inst.get("workspace")):
            if root and (here == os.path.abspath(root) or here.startswith(os.path.abspath(root) + os.sep)):
                score = len(os.path.abspath(root))
                if best is None or score > best[0]:
                    best = (score, int(inst["backend_port"]))
    return f"http://127.0.0.1:{best[1]}" if best else None


def message(resp: dict[str, Any], path: str) -> str | None:
    changed = resp.get("changed") or []
    untagged = resp.get("untagged") or []
    if not changed and not untagged:
        return None
    name = os.path.basename(path)
    lines = [f"telelog: {name} has tags to refresh. Edit only the `# @telelog` comment lines, nothing else."]
    if changed:
        lines.append("Body changed since the tag was verified (update purpose, in/out, db, algo if they no longer fit):")
        lines += [f"  - {c['id']} (line {c.get('line', '?')})" for c in changed[:MAX_LISTED]]
    if untagged:
        lines.append("No tag yet (add one at the depth its role needs; use get_function for context):")
        lines += [f"  - {i}" for i in untagged[:MAX_LISTED]]
    ids = [c["id"] for c in changed] + list(untagged)
    more = len(ids) - 2 * MAX_LISTED if len(ids) > 2 * MAX_LISTED else 0
    if more > 0:
        lines.append(f"  (+{more} more; run validate_tags)")
    lines.append("When done, call record_progress with these ids so this reminder clears.")
    return "\n".join(lines)


def fetch(url: str) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=TIMEOUT) as r:  # noqa: S310 — a local collector URL
        return json.loads(r.read().decode("utf-8"))


def run(stdin: TextIO, stdout: TextIO, env: dict[str, str], get: Callable[[str], dict[str, Any]] = fetch,
        instances_path: Path = DEFAULT_INSTANCES) -> int:
    try:
        event = json.load(stdin)
        path = (event.get("tool_input") or {}).get("file_path") or ""
        if not path.endswith(".py") or f"{os.sep}.telelog{os.sep}" in path:
            return 0
        base = resolve_url(env, event.get("cwd") or os.getcwd(), instances_path)
        if base is None:
            return 0
        resp = get(f"{base}/viewer/telelog/changed?{urllib.parse.urlencode({'paths': path})}")
        text = message(resp, path)
        if text:
            json.dump({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": text}}, stdout)
    except Exception:  # noqa: BLE001 — a hook must never break the edit that triggered it
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(run(sys.stdin, sys.stdout, dict(os.environ)))

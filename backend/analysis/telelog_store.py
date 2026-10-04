"""backend/analysis/telelog_store.py — telelog's state, config and audit paging.

State lives in the target project under ``.telelog/state/`` (outside source files):
  verified.json   function id -> fingerprint recorded when its tag was last verified
  progress.json   ids already handled by an audit run, so an interrupted run resumes
``.telelog/config`` is written by people and only ever read here:

    # which functions need no tag (added to the built-in defaults)
    exclude: scripts/**
    defaults: off          # drop the built-in test/migration/generated excludes

Writes are atomic (tmp + replace) and serialised per directory; a missing or
corrupt file reads as empty rather than failing.
"""

from __future__ import annotations

import json
import re
import threading
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from backend.analysis.callgraph import N
from backend.analysis.telelog import ParseResult, read_tags, tagged_function_ids

VERSION = 1
DEFAULT_EXCLUDES = (
    "tests/**", "**/tests/**", "test_*.py", "**/test_*.py", "*_test.py", "**/*_test.py", "conftest.py", "**/conftest.py",
    "**/migrations/**", "**/alembic/versions/**", "*_pb2.py", "**/*_pb2.py", "*_pb2_grpc.py", "**/*_pb2_grpc.py",
)
HIGH_FAN_IN = 3
_LOCKS: dict[str, threading.Lock] = defaultdict(threading.Lock)


def _glob_re(pattern: str) -> re.Pattern[str]:
    out, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif pattern.startswith("**", i):
            out, i = out + ".*", i + 2
        elif pattern[i] == "*":
            out, i = out + "[^/]*", i + 1
        elif pattern[i] == "?":
            out, i = out + "[^/]", i + 1
        else:
            out, i = out + re.escape(pattern[i]), i + 1
    return re.compile(out + r"\Z")


class TelelogConfig:
    def __init__(self, excludes: Iterable[str] = (), use_defaults: bool = True):
        self.excludes = list(excludes)
        self.use_defaults = use_defaults
        patterns = (DEFAULT_EXCLUDES if use_defaults else ()) + tuple(self.excludes)
        self._res = [_glob_re(p) for p in patterns]

    def is_excluded(self, rel_path: str) -> bool:
        path = rel_path.replace("\\", "/").lstrip("./")
        return any(r.match(path) for r in self._res)

    def predicate(self) -> Callable[[Any], bool]:
        """For validate_tags / list_untagged: True when a registry Func's file is excluded."""
        return lambda f: self.is_excluded(f.file_path)


def load_config(project_root: str | Path) -> TelelogConfig:
    try:
        text = (Path(project_root) / ".telelog" / "config").read_text(encoding="utf-8")
    except OSError:
        return TelelogConfig()
    excludes: list[str] = []
    use_defaults = True
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        key, sep, val = line.partition(":")
        key, val = key.strip().lower(), val.strip()
        if not sep:
            continue
        if key == "exclude" and val:
            excludes.append(val)
        elif key == "defaults" and val.lower() in ("off", "false", "no"):
            use_defaults = False
    return TelelogConfig(excludes, use_defaults)


class TelelogStore:
    def __init__(self, project_root: str | Path):
        self.root = Path(project_root)
        self.dir = self.root / ".telelog" / "state"
        self._lock = _LOCKS[str(self.dir)]

    def _read(self, name: str) -> dict[str, Any]:
        try:
            data = json.loads((self.dir / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) and data.get("version") == VERSION else {}

    def _write(self, name: str, data: dict[str, Any]) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = self.dir / f"{name}.tmp"
        tmp.write_text(json.dumps({"version": VERSION, **data}, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(self.dir / name)

    # ── verified fingerprints ────────────────────────────────────────────
    def verified(self) -> dict[str, str]:
        return dict(self._read("verified.json").get("hashes", {}))

    def mark_verified(self, fingerprints: Mapping[str, str]) -> None:
        """Record that these functions' tags match their current bodies (id -> fingerprint)."""
        with self._lock:
            hashes = self.verified()
            hashes.update(fingerprints)
            self._write("verified.json", {"hashes": hashes})

    def forget_verified(self, ids: Iterable[str]) -> None:
        with self._lock:
            hashes = self.verified()
            for fid in ids:
                hashes.pop(fid, None)
            self._write("verified.json", {"hashes": hashes})

    # ── audit progress ───────────────────────────────────────────────────
    def get_progress(self) -> dict[str, Any]:
        data = self._read("progress.json")
        done = sorted(data.get("done", []))
        return {"done": done, "count": len(done), "updated": data.get("updated")}

    def record_progress(self, ids: Iterable[str]) -> dict[str, Any]:
        with self._lock:
            done = set(self._read("progress.json").get("done", [])) | set(ids)
            self._write("progress.json", {"done": sorted(done), "updated": datetime.now(timezone.utc).isoformat()})
        return self.get_progress()

    def reset_progress(self) -> None:
        with self._lock:
            self._write("progress.json", {"done": [], "updated": datetime.now(timezone.utc).isoformat()})


# ── audit paging ─────────────────────────────────────────────────────────────

@dataclass
class CallInfo:
    rank: dict[str, int]
    """Rank 0 = endpoint handler, 1 = its direct callees (anything deeper is absent)."""
    callers: dict[str, set[str]]
    callees: dict[str, set[str]]
    handlers: set[str]
    tables: dict[str, set[str]]
    """function id -> database tables it touches."""


def call_info(analysis) -> CallInfo:
    cg = analysis.callgraph
    info = CallInfo({}, defaultdict(set), defaultdict(set), set(), defaultdict(set))

    def walk(node: N, owner: str | None, depth: int, seen: set[int]) -> None:
        if id(node) in seen:
            return
        seen.add(id(node))
        here = owner
        if node.kind == "function" and node.function_id:
            here = node.function_id
            if owner is not None and owner != here:
                info.callers[here].add(owner)
                info.callees[owner].add(here)
            if depth <= 1:
                info.rank[here] = min(info.rank.get(here, depth), depth)
            depth += 1
        elif node.kind == "db" and owner:
            info.tables[owner].add(node.name)
        for child in node.children:
            walk(child, here, depth, seen)

    for ep in analysis.routes.endpoints:
        root = cg.endpoint_root(ep)
        if root is None:
            continue
        info.handlers.add(ep.handler_id)
        walk(root, None, 0, set())
    return info


def list_untagged(
    analysis,
    limit: int = 15,
    cursor: str | None = None,
    feature: str | None = None,
    exclude: Callable[[Any], bool] | None = None,
    parsed: dict[str, ParseResult] | None = None,
) -> dict[str, Any]:
    """A page of functions with no tag: endpoint handlers first, then their direct callees, then the rest.

    The cursor is the sort key of the last item returned ("rank:id"), not an offset, so a function that
    gets tagged between pages never makes another one skip. `feature` keeps only functions that call or
    are called by a function already tagged with that feature.
    """
    parsed = read_tags(analysis) if parsed is None else parsed
    tags = tagged_function_ids(parsed)
    ci = call_info(analysis)
    rank, callers, callees, handlers, db = ci.rank, ci.callers, ci.callees, ci.handlers, ci.tables
    items: list[tuple[int, str]] = []
    for fid, f in analysis.registry.funcs.items():
        if fid in tags or (exclude is not None and exclude(f)):
            continue
        r = 0 if fid in handlers else min(rank.get(fid, 2), 2)
        if feature:
            near = callers.get(fid, set()) | callees.get(fid, set())
            if not any(n in tags and tags[n].feature == feature for n in near):
                continue
        items.append((r, fid))
    items.sort()
    start = 0
    if cursor:
        head, _, tail = cursor.partition(":")
        key = (int(head), tail) if head.isdigit() else (-1, "")
        start = next((i for i, it in enumerate(items) if it > key), len(items))
    page = items[start:start + max(1, limit)]
    funcs = analysis.registry.funcs

    def hints(fid: str) -> list[str]:
        out = []
        if fid in handlers:
            out.append("endpoint")
        if fid in db:
            out.append("db-touching")
        if len(callers.get(fid, ())) >= HIGH_FAN_IN:
            out.append("high-fan-in")
        return out

    nxt = f"{page[-1][0]}:{page[-1][1]}" if page and start + len(page) < len(items) else None
    return {
        "items": [
            {"id": fid, "module": funcs[fid].module, "line": funcs[fid].line, "hints": hints(fid)} for _, fid in page
        ],
        "next_cursor": nxt,
        "total_untagged": len(items),
    }

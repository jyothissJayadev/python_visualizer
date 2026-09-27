"""backend/analysis/coderun.py — is brain running the code that is on disk?

Brain reports when its process started (ISO time, on every handshake). If any
of its source files has been modified since, the running process is older than
the code the analysis just read — live traces and the static picture can then
disagree, and that should never be a surprise.

(Comparing the `code_fingerprint` brain also reports cannot answer this: inside
a git repo it is just the HEAD sha, which does not change when files are edited
without committing.)
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

_SKIP_DIRS = {".git", "__pycache__", "node_modules", ".venv", "venv", "env", ".pytest_cache", ".mypy_cache"}
GRACE_SECONDS = 2.0  # files written while brain was starting are not "newer"


def _parse(started_at: str | None) -> float | None:
    if not started_at:
        return None
    try:
        dt = datetime.fromisoformat(started_at)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def brain_code_status(project_path: str, started_at: str | None) -> dict[str, Any]:
    """{"state": "current" | "older" | "unknown", "newer_files": n, "newest_file": rel, ...}"""
    started = _parse(started_at)
    if started is None or not os.path.isdir(project_path):
        return {"state": "unknown", "newer_files": 0, "newest_file": None, "started_at": started_at}
    # brain's runtime code lives under app/ (the same scope its own fingerprint uses)
    scope = os.path.join(project_path, "app")
    root = scope if os.path.isdir(scope) else project_path
    newer = 0
    newest: tuple[float, str] | None = None
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS and not d.startswith(".")]
        for name in files:
            if not name.endswith(".py"):
                continue
            path = os.path.join(dirpath, name)
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                continue
            if mtime > started + GRACE_SECONDS:
                newer += 1
                if newest is None or mtime > newest[0]:
                    newest = (mtime, os.path.relpath(path, project_path))
    return {
        "state": "older" if newer else "current",
        "newer_files": newer,
        "newest_file": newest[1] if newest else None,
        "newest_at": datetime.fromtimestamp(newest[0], tz=timezone.utc).isoformat() if newest else None,
        "started_at": started_at,
    }

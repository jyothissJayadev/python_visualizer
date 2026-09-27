from __future__ import annotations

import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from backend.analysis.coderun import brain_code_status


def _project(tmp_path: Path) -> Path:
    (tmp_path / "app").mkdir()
    for name in ("a.py", "b.py"):
        (tmp_path / "app" / name).write_text("x = 1\n")
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "t.py").write_text("x = 1\n")  # outside app/: not brain's runtime code
    return tmp_path


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def test_code_older_than_the_files_on_disk_is_detected(tmp_path: Path):
    root = _project(tmp_path)
    started = time.time() - 600
    for f in (root / "app").glob("*.py"):
        os.utime(f, (started - 100, started - 100))  # written before brain started
    assert brain_code_status(str(root), _iso(started))["state"] == "current"

    edited = root / "app" / "b.py"
    now = time.time()
    os.utime(edited, (now, now))  # edited after brain started
    status = brain_code_status(str(root), _iso(started))
    assert status["state"] == "older" and status["newer_files"] == 1 and status["newest_file"] == os.path.join("app", "b.py")


def test_files_written_while_brain_was_starting_and_test_files_do_not_count(tmp_path: Path):
    root = _project(tmp_path)
    started = time.time() - 600
    os.utime(root / "app" / "b.py", (started - 100, started - 100))  # written before brain started
    os.utime(root / "app" / "a.py", (started + 1, started + 1))  # inside the grace window
    now = time.time()
    os.utime(root / "tests" / "t.py", (now, now))  # tests are not brain's runtime code
    assert brain_code_status(str(root), _iso(started))["state"] == "current"


def test_unknown_when_brain_has_not_said_when_it_started(tmp_path: Path):
    root = _project(tmp_path)
    assert brain_code_status(str(root), None)["state"] == "unknown"
    assert brain_code_status(str(root), "not a date")["state"] == "unknown"
    assert brain_code_status(str(tmp_path / "missing"), _iso(time.time()))["state"] == "unknown"
    # naive timestamps are taken as UTC rather than crashing
    assert brain_code_status(str(root), (datetime.now(timezone.utc) + timedelta(days=1)).replace(tzinfo=None).isoformat())["state"] == "current"

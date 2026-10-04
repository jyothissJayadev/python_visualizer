"""Golden snapshot of build_map for a project with no @telelog tags.

The snapshot was captured before telelog touched build_map. If this test fails,
the deterministic map payload changed for an untagged project. Regenerate with
`.venv/bin/python -m tests.analysis.test_map_golden` only for a deliberate change.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from backend.analysis.engine import Analysis
from backend.analysis.mapmodel import build_map
from tests.analysis.test_map import FILES

GOLDEN = Path(__file__).parent / "golden" / "build_map_untagged.json"


def _write_project(root: Path) -> None:
    for rel, src in FILES.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(src, encoding="utf-8")


def snapshot(root: Path, overrides: dict[str, str] | None = None) -> str:
    """build_map output as stable JSON, with the temp root replaced by <root>."""
    payload = build_map(Analysis(str(root)), overrides)
    text = json.dumps(payload, indent=2, sort_keys=True)
    return text.replace(str(root), "<root>") + "\n"


def test_untagged_build_map_matches_golden(tmp_path: Path):
    _write_project(tmp_path)
    assert snapshot(tmp_path) == GOLDEN.read_text(encoding="utf-8")


if __name__ == "__main__":  # regenerate the snapshot
    with tempfile.TemporaryDirectory() as d:
        _write_project(Path(d).resolve())
        GOLDEN.write_text(snapshot(Path(d).resolve()), encoding="utf-8")
        sys.stdout.write(f"wrote {GOLDEN}\n")

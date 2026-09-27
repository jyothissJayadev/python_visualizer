import asyncio
import os

from backend.analysis.lineage import LineageService


def _apps(tmp_path):
    brain = tmp_path / "apps" / "brain"
    backend = tmp_path / "apps" / "backend"
    brain.mkdir(parents=True)
    backend.mkdir(parents=True)
    (brain / "a.py").write_text("x = 1\n")
    (backend / "r.js").write_text("module.exports = 1\n")
    (backend / "node_modules").mkdir()
    (backend / "node_modules" / "skip.js").write_text("1")
    return brain, backend


def test_fingerprint_tracks_sources_only(tmp_path):
    brain, backend = _apps(tmp_path)
    svc = LineageService(str(brain), cache_file=None)
    assert svc.available()
    first = svc.compute_fingerprint()
    assert first == svc.compute_fingerprint()
    (backend / "node_modules" / "skip.js").write_text("changed, longer")
    (brain / "notes.txt").write_text("not code")
    assert svc.compute_fingerprint() == first
    (backend / "r.js").write_text("module.exports = 22\n")
    assert svc.compute_fingerprint() != first


def test_stale_until_scanned_from_current_sources(tmp_path):
    brain, backend = _apps(tmp_path)
    svc = LineageService(str(brain), cache_file=None)
    assert asyncio.run(svc.is_stale())  # never scanned
    svc.fingerprint = svc.compute_fingerprint()
    assert not asyncio.run(svc.is_stale())
    (brain / "a.py").write_text("x = 12345\n")
    os.utime(brain / "a.py", (1, 1))
    assert asyncio.run(svc.is_stale())

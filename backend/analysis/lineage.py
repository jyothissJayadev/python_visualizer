"""backend/analysis/lineage.py — End-to-End full stack cross-layer lineage service.

Maps every Brain endpoint (FastAPI) through the Node.js backend (services/brainClient -> controllers -> Express routes)
to the frontend and admin web clients (API client methods -> React components & trigger event handlers).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

logger = logging.getLogger("brain_terminal.lineage")

SCANNER_SCRIPT = Path(__file__).resolve().parent.parent / "scanner" / "lineage_scanner.cjs"
CACHE_FILE = Path(__file__).resolve().parent.parent.parent / ".cache" / "lineage_cache.json"

# What the scanner reads, per app — the fingerprint covers exactly these, so "did anything it
# reads change?" is answered without running it (13 ms for ~1,000 files; a scan takes seconds).
_SKIP_DIRS = {"node_modules", "dist", "build", "coverage", "__pycache__"}
_CODE_EXT = {
    "brain": {".py"},
    "backend": {".js", ".mjs", ".cjs", ".ts"},
    "frontend": {".js", ".jsx", ".ts", ".tsx"},
    "admin": {".js", ".jsx", ".ts", ".tsx"},
}
POLL_SECONDS = 3.0

Broadcast = Callable[[dict], Awaitable[None]]


class LineageService:
    def __init__(self, project_path: str, cache_file: Path | None = CACHE_FILE):
        self.project_path = os.path.abspath(project_path)
        self.cache_file = cache_file  # None: no persistence (tests)
        self.fingerprint: str | None = None
        """Fingerprint of the sources the current data was scanned from."""
        self._seen_fingerprint: str | None = None
        """Latest fingerprint the watcher observed (what is on disk now)."""
        self._failed_fingerprint: str | None = None
        self._broadcast: Broadcast | None = None
        self._task: asyncio.Task | None = None
        self.status = "idle"  # idle | scanning | error
        self.error: str | None = None
        self.last_scanned_at: float | None = None
        self.duration_ms: int | None = None
        self._data: dict[str, Any] | None = None
        self._lock = asyncio.Lock()
        self._load_cache()

    def _load_cache(self) -> None:
        try:
            if self.cache_file is not None and self.cache_file.exists():
                with open(self.cache_file, "r", encoding="utf-8") as f:
                    cached = json.load(f)
                    self._data = cached
                    self.fingerprint = cached.get("fingerprint")
                    self.last_scanned_at = cached.get("timestamp", 0) / 1000.0
                    self.duration_ms = cached.get("duration_ms", 0)
                    logger.info("Loaded lineage data from cache (%d chains)", len(cached.get("chains", [])))
        except Exception as e:  # noqa: BLE001
            logger.warning("Could not load lineage cache: %s", e)

    def _save_cache(self, data: dict[str, Any]) -> None:
        if self.cache_file is None:
            return
        try:
            self.cache_file.parent.mkdir(parents=True, exist_ok=True)
            with open(self.cache_file, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
        except Exception as e:  # noqa: BLE001
            logger.warning("Could not save lineage cache: %s", e)

    async def get_lineage(self, force: bool = False) -> dict[str, Any]:
        async with self._lock:
            if self._data and not force:
                return {
                    "status": self.status,
                    "error": self.error,
                    "last_scanned_at": self.last_scanned_at,
                    "duration_ms": self.duration_ms,
                    "stale": await self.is_stale(),
                    **self._data,
                }

        return await self.rescan()

    # ── freshness ────────────────────────────────────────────────────────
    def _app_dirs(self) -> dict[str, str]:
        apps_dir = os.path.dirname(self.project_path)
        return {
            "brain": self.project_path,
            "backend": os.path.join(apps_dir, "backend"),
            "frontend": os.path.join(apps_dir, "frontend", "src"),
            "admin": os.path.join(apps_dir, "admin", "src"),
        }

    def available(self) -> bool:
        """The sibling apps exist: without them there is nothing to trace end to end."""
        dirs = self._app_dirs()
        return any(os.path.isdir(dirs[k]) for k in ("backend", "frontend", "admin"))

    def compute_fingerprint(self) -> str:
        """sha1 over (path, mtime, size) of every source file the scanner reads."""
        digest = hashlib.sha1()
        for app, root in self._app_dirs().items():
            for dirpath, dirs, files in os.walk(root):
                dirs[:] = sorted(d for d in dirs if d not in _SKIP_DIRS and not d.startswith("."))
                for name in sorted(files):
                    if os.path.splitext(name)[1] not in _CODE_EXT[app]:
                        continue
                    path = os.path.join(dirpath, name)
                    try:
                        st = os.stat(path)
                    except OSError:
                        continue
                    digest.update(f"{path}\0{st.st_mtime_ns}\0{st.st_size}\n".encode())
        return digest.hexdigest()[:16]

    async def is_stale(self) -> bool:
        """Has any source changed since the current data was scanned? Data from
        before fingerprints existed (no fingerprint) counts as stale."""
        current = self._seen_fingerprint or await asyncio.to_thread(self.compute_fingerprint)
        return self.fingerprint is None or current != self.fingerprint

    def _status_message(self, kind: str, stale: bool) -> dict[str, Any]:
        return {
            "kind": kind, "status": self.status, "stale": stale, "error": self.error,
            "last_scanned_at": self.last_scanned_at, "duration_ms": self.duration_ms,
        }

    async def _emit(self, kind: str, stale: bool) -> None:
        if self._broadcast is not None:
            try:
                await self._broadcast(self._status_message(kind, stale))
            except Exception:  # noqa: BLE001
                logger.exception("lineage broadcast failed")

    async def start(self, broadcast: Broadcast | None = None) -> None:
        """Keep the data fresh: rescan when a source changes (and at startup if the
        cached data is out of date), then tell open dashboards."""
        self._broadcast = broadcast
        if self._task is None and self.available():
            self._task = asyncio.create_task(self._watch())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None

    async def _watch(self) -> None:
        # Polling, not filesystem events: the scanned apps contain node_modules (tens of
        # thousands of directories), and the fingerprint check is ~13 ms.
        last: str | None = None
        while True:
            fp = await asyncio.to_thread(self.compute_fingerprint)
            self._seen_fingerprint = fp
            if fp != self.fingerprint and fp != self._failed_fingerprint:
                if fp != last:  # still changing (a save in progress): wait one more poll
                    last = fp
                    await self._emit("lineage_status", True)
                else:
                    await self.rescan()
                    if self.status == "error":
                        self._failed_fingerprint = fp  # do not retry until something changes again
                    last = None
                    await self._emit("lineage_updated", False)
            await asyncio.sleep(POLL_SECONDS)

    async def rescan(self) -> dict[str, Any]:
        async with self._lock:
            self.status = "scanning"
            self.error = None
            t0 = time.monotonic()
            scan_fingerprint = await asyncio.to_thread(self.compute_fingerprint)

            try:
                # Find sibling directories from project_path
                brain_dir = self.project_path
                apps_dir = os.path.dirname(brain_dir)
                backend_dir = os.path.join(apps_dir, "backend")
                frontend_dir = os.path.join(apps_dir, "frontend", "src")
                admin_dir = os.path.join(apps_dir, "admin", "src")

                cmd = [
                    "node",
                    str(SCANNER_SCRIPT),
                    "--brain", brain_dir,
                    "--backend", backend_dir,
                    "--frontend", frontend_dir,
                    "--admin", admin_dir,
                ]

                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )

                stdout, stderr = await proc.communicate()

                if proc.returncode != 0:
                    err_msg = stderr.decode("utf-8", errors="replace").strip() or f"Scanner exited with code {proc.returncode}"
                    self.status = "error"
                    self.error = err_msg
                    logger.error("Lineage scanner failed: %s", err_msg)
                    return {
                        "status": "error",
                        "error": err_msg,
                        "chains": self._data.get("chains", []) if self._data else [],
                        "summary": self._data.get("summary", {}) if self._data else {},
                    }

                parsed = json.loads(stdout.decode("utf-8"))
                duration_ms = int((time.monotonic() - t0) * 1000)
                parsed["fingerprint"] = scan_fingerprint
                self.fingerprint = scan_fingerprint
                self._data = parsed
                self.status = "idle"
                self.error = None
                self.last_scanned_at = time.time()
                self.duration_ms = duration_ms
                self._save_cache(parsed)

                return {
                    "status": "idle",
                    "error": None,
                    "last_scanned_at": self.last_scanned_at,
                    "duration_ms": self.duration_ms,
                    "stale": False,
                    **parsed,
                }

            except Exception as e:  # noqa: BLE001
                self.status = "error"
                self.error = str(e)
                logger.exception("Error running lineage scan")
                return {
                    "status": "error",
                    "error": str(e),
                    "chains": self._data.get("chains", []) if self._data else [],
                    "summary": self._data.get("summary", {}) if self._data else {},
                }

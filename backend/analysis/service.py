"""backend/analysis/service.py — keeps one Analysis of the target project
fresh and serves it.

  * **fingerprint** — sha1 over every source file's (path, mtime, size); cheap
    enough to compute on every check, so "did the code change?" is exact.
  * **refresh** — re-analyses in a worker thread (a full analysis of a
    ~300-file project is about a second, so it is redone whole rather than
    patched — cross-module resolution makes partial updates error-prone) and
    swaps the result in atomically; readers never see a half-built analysis.
  * **watcher** — ``watchfiles`` (debounced) triggers a refresh when a .py
    file changes; falls back to polling the fingerprint if unavailable.
  * **cache** — the route list is written to ``.cache/`` in *this* repo (never
    in the target project) so a restart can serve endpoints immediately,
    before the first analysis finishes.
  * every state change is pushed to dashboards as a ``{"kind": "analysis_*"}``
    message through the ``broadcast`` callback.
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

from backend.analysis.callgraph import N
from backend.analysis.dbindex import build_database_index
from backend.analysis.engine import Analysis
from backend.analysis.funcview import data_summary, function_view, view_stats
from backend.analysis.models import Endpoint
from backend.analysis.overlay import EndpointMatcher
from backend.config import ExplorerConfig, project_path_problem

logger = logging.getLogger("brain_terminal.analysis")

CACHE_DIR = Path(__file__).resolve().parent.parent.parent / ".cache"
CACHE_VERSION = 1

Broadcast = Callable[[dict], Awaitable[None]]


class AnalysisService:
    def __init__(
        self,
        config: ExplorerConfig,
        broadcast: Broadcast | None = None,
        cache_dir: Path | None = CACHE_DIR,
        on_analyzed: Callable[[], Any] | None = None,
    ):
        self.config = config
        self.project_path = os.path.abspath(config.project_path)
        self._broadcast = broadcast
        self._on_analyzed = on_analyzed
        self._cache_dir = cache_dir
        self.analysis: Analysis | None = None
        self.fingerprint: str | None = None
        self.analyzed_at: float | None = None
        self.duration_ms: int | None = None
        self.status = "idle"  # idle | scanning | error
        self.error: str | None = None
        self.reason: str | None = None
        self.generation = 0
        self.cached_routes: dict[str, Any] | None = None
        """Route list loaded from the disk cache (served until the first
        analysis of this process completes)."""
        self._roots: dict[str, tuple[N, dict[str, Any]]] = {}
        self._matcher: EndpointMatcher | None = None
        self._data: dict[str, dict[str, Any]] = {}
        self._db_index: dict[str, Any] | None = None
        self._lock = asyncio.Lock()
        self._watch_task: asyncio.Task | None = None

    # ── fingerprint ──────────────────────────────────────────────────────
    def compute_fingerprint(self) -> str:
        digest = hashlib.sha1()
        count = 0
        for dirpath, dirs, files in os.walk(self.project_path):
            dirs[:] = sorted(d for d in dirs if not self.config.should_ignore_dir(d))
            for name in sorted(files):
                if not name.endswith(".py"):
                    continue
                path = os.path.join(dirpath, name)
                try:
                    st = os.stat(path)
                except OSError:
                    continue
                rel = os.path.relpath(path, self.project_path)
                digest.update(f"{rel}\0{st.st_mtime_ns}\0{st.st_size}\n".encode())
                count += 1
        return f"{count}f:{digest.hexdigest()[:12]}"

    # ── lifecycle ────────────────────────────────────────────────────────
    async def start(self, watch: bool = True) -> None:
        self._load_cache()
        # first analysis runs in the background so the server is up at once
        asyncio.create_task(self.refresh(force=True, reason="startup"))
        if watch:
            self._watch_task = asyncio.create_task(self._watch())

    async def stop(self) -> None:
        if self._watch_task is not None:
            self._watch_task.cancel()
            try:
                await self._watch_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._watch_task = None

    async def refresh(self, force: bool = False, reason: str = "manual") -> bool:
        """Re-analyse if the code changed (or `force`). Returns True if a new
        analysis was installed."""
        async with self._lock:
            fp = await asyncio.to_thread(self.compute_fingerprint)
            if not force and fp == self.fingerprint and self.analysis is not None:
                return False
            self.status, self.reason, self.error = "scanning", reason, None
            await self._emit("analysis_status")
            started = time.perf_counter()
            try:
                problem = project_path_problem(self.project_path)
                if problem:
                    raise FileNotFoundError(problem)
                analysis = await asyncio.to_thread(
                    Analysis, self.project_path, frozenset(self.config.ignored_directories)
                )
                if not analysis.index.modules:
                    raise ValueError(f"no Python files found under {self.project_path}")
            except Exception as exc:  # noqa: BLE001 — keep serving the previous analysis
                logger.exception("analysis failed")
                self.status, self.error = "error", f"{type(exc).__name__}: {exc}"
                await self._emit("analysis_status")
                return False
            self.analysis = analysis
            self.fingerprint = fp
            self.analyzed_at = time.time()
            self.duration_ms = int((time.perf_counter() - started) * 1000)
            self.generation += 1
            self.status = "idle"
            self._roots.clear()
            self._matcher = None
            self._data.clear()
            self._db_index = None
            self.cached_routes = None
            await asyncio.to_thread(self._save_cache)
            if self._on_analyzed is not None:
                # other views of the same code (the terminal's function catalogue) refresh in step
                try:
                    await asyncio.to_thread(self._on_analyzed)
                except Exception:  # noqa: BLE001
                    logger.exception("post-analysis refresh failed")
            logger.info(
                "analysis #%d (%s): %d endpoints in %d ms", self.generation, reason,
                len(analysis.routes.endpoints), self.duration_ms,
            )
            await self._emit("analysis_updated")
            return True

    async def _watch(self) -> None:
        try:
            from watchfiles import awatch
        except ImportError:  # pragma: no cover
            awatch = None

        if project_path_problem(self.project_path):
            logger.warning("not watching: %s", project_path_problem(self.project_path))
        ignore = self.config.should_ignore_dir

        def only_source(_change: Any, path: str) -> bool:
            if not path.endswith(".py"):
                return False
            rel = os.path.relpath(path, self.project_path).split(os.sep)
            return not any(ignore(part) for part in rel[:-1])

        if awatch is not None and not project_path_problem(self.project_path):
            try:
                async for _changes in awatch(self.project_path, watch_filter=only_source, debounce=800, step=200):
                    await self.refresh(reason="file change")
                return
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.exception("file watcher failed; falling back to polling")
        while True:
            await asyncio.sleep(3)
            await self.refresh(reason="file change")

    # ── serving ──────────────────────────────────────────────────────────
    def status_payload(self) -> dict[str, Any]:
        routes = self.analysis.routes if self.analysis else None
        return {
            "status": self.status,
            "reason": self.reason,
            "error": self.error,
            "ready": self.analysis is not None,
            "generation": self.generation,
            "fingerprint": self.fingerprint,
            "analyzed_at": self.analyzed_at,
            "duration_ms": self.duration_ms,
            "project_path": self.project_path,
            "endpoint_count": len(routes.endpoints) if routes else (
                len(self.cached_routes["endpoints"]) if self.cached_routes else 0
            ),
            "from_cache": self.analysis is None and self.cached_routes is not None,
        }

    def endpoint(self, endpoint_id: str) -> Endpoint | None:
        return self.analysis.endpoint(endpoint_id) if self.analysis else None

    def tree_root(self, ep: Endpoint) -> tuple[N, dict[str, Any]] | None:
        """(root, stats) of an endpoint's *functions-only* hierarchy; built once
        per analysis generation."""
        cached = self._roots.get(ep.id)
        if cached is not None:
            return cached
        assert self.analysis is not None
        full = self.analysis.callgraph.endpoint_root(ep)
        if full is None:
            return None
        view = function_view(full)
        self._roots[ep.id] = (view, view_stats(full, view))
        return self._roots[ep.id]

    def data_for(self, ep: Endpoint) -> dict[str, Any] | None:
        """Database tables an endpoint touches (per analysis generation)."""
        built = self.tree_root(ep)
        if built is None:
            return None
        if ep.id not in self._data:
            self._data[ep.id] = data_summary(built[0])
        return self._data[ep.id]

    def database_index(self) -> dict[str, Any]:
        """Every table brain touches, with its functions, endpoints and fields
        (per analysis generation)."""
        assert self.analysis is not None
        if self._db_index is None:
            self._db_index = build_database_index(self.analysis)
        return self._db_index

    def matcher(self) -> EndpointMatcher:
        """Maps concrete request paths to endpoints (per analysis generation)."""
        assert self.analysis is not None
        if self._matcher is None:
            self._matcher = EndpointMatcher((e.id, e.method, e.path) for e in self.analysis.routes.endpoints)
        return self._matcher

    async def _emit(self, kind: str) -> None:
        if self._broadcast is None:
            return
        try:
            await self._broadcast({"kind": kind, **self.status_payload()})
        except Exception:  # noqa: BLE001
            logger.exception("broadcast failed")

    # ── disk cache ───────────────────────────────────────────────────────
    def _cache_file(self) -> Path | None:
        if self._cache_dir is None:
            return None
        key = hashlib.sha1(self.project_path.encode()).hexdigest()[:12]
        return self._cache_dir / f"routes-{key}.json"

    def _save_cache(self) -> None:
        path = self._cache_file()
        if path is None or self.analysis is None:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "version": CACHE_VERSION,
                "fingerprint": self.fingerprint,
                "project_path": self.project_path,
                "endpoints": [e.model_dump() for e in self.analysis.routes.endpoints],
            }
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload), encoding="utf-8")
            tmp.replace(path)
        except OSError:
            logger.warning("could not write analysis cache", exc_info=True)

    def _load_cache(self) -> None:
        path = self._cache_file()
        if path is None or not path.is_file():
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if data.get("version") != CACHE_VERSION or data.get("project_path") != self.project_path:
            return
        self.cached_routes = data
        self.fingerprint = None  # the real fingerprint is set by the first analysis

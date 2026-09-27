"""backend/analysis/templates.py — Trace Templates: named, saved groups of
Terminal-armed functions (id + deep/shallow mode per function), so a
debugging session's instrumentation can be replayed with one click instead
of re-picked by hand every time.

Persisted per project as a small JSON file under ``.cache/``, following the
same atomic-write pattern as ``AnalysisService`` (backend/analysis/service.py):
versioned payload, ``.tmp`` + ``path.replace()``, keyed by
``sha1(project_path)[:12]``.

Both the REST endpoints (backend/api/viewer.py) and the MCP tools
(backend/mcp_server.py, via the REST endpoints) are thin wrappers around this
store, so validation and catalog-status annotation live in exactly one place.
"""

from __future__ import annotations

import asyncio
import difflib
import hashlib
import json
import time
import uuid
from pathlib import Path
from typing import Any

TEMPLATES_VERSION = 1


class TemplateValidationError(ValueError):
    """Bad template name or function list. Callers turn this into a 400/409
    (REST) or an ``{"error": ...}`` payload (MCP) — never a 500."""


class TemplateStore:
    def __init__(self, project_path: str, cache_dir: Path | None):
        self.project_path = project_path
        self._cache_dir = cache_dir
        self._lock = asyncio.Lock()
        self._templates: list[dict[str, Any]] = []
        self._load()

    # -- persistence ---------------------------------------------------
    def _cache_file(self) -> Path | None:
        if self._cache_dir is None:
            return None
        key = hashlib.sha1(self.project_path.encode()).hexdigest()[:12]
        return self._cache_dir / f"templates-{key}.json"

    def _load(self) -> None:
        path = self._cache_file()
        if path is None or not path.is_file():
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if data.get("version") != TEMPLATES_VERSION or data.get("project_path") != self.project_path:
            return
        self._templates = data.get("templates") or []

    def _save(self) -> None:
        path = self._cache_file()
        if path is None:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "version": TEMPLATES_VERSION,
                "project_path": self.project_path,
                "templates": self._templates,
            }
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            tmp.replace(path)
        except OSError:
            pass

    # -- validation ------------------------------------------------------
    @staticmethod
    def _normalize_functions(functions: list[dict] | None) -> list[dict[str, Any]]:
        if not isinstance(functions, list) or not functions:
            raise TemplateValidationError("functions must be a non-empty list")
        out: list[dict[str, Any]] = []
        seen: set[str] = set()
        for entry in functions:
            fid = str((entry or {}).get("id") or "").strip()
            if not fid:
                raise TemplateValidationError("every function entry needs a non-empty id")
            if fid in seen:
                continue
            seen.add(fid)
            out.append({"id": fid, "deep": bool((entry or {}).get("deep"))})
        if not out:
            raise TemplateValidationError("functions must be a non-empty list")
        return out

    def _check_name(self, name: str | None, *, exclude_id: str | None = None) -> str:
        cleaned = (name or "").strip()
        if not cleaned:
            raise TemplateValidationError("name must not be empty")
        lowered = cleaned.lower()
        for t in self._templates:
            if t["id"] == exclude_id:
                continue
            if t["name"].lower() == lowered:
                raise TemplateValidationError(f"a template named {t['name']!r} already exists")
        return cleaned

    @staticmethod
    def _now() -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    # -- CRUD --------------------------------------------------------------
    def list_raw(self) -> list[dict[str, Any]]:
        return list(self._templates)

    def get(self, template_id: str) -> dict[str, Any] | None:
        return next((t for t in self._templates if t["id"] == template_id), None)

    async def create(self, name: str | None, functions: list[dict] | None) -> dict[str, Any]:
        async with self._lock:
            self._load()
            checked_name = self._check_name(name)
            checked_functions = self._normalize_functions(functions)
            now = self._now()
            template = {
                "id": f"tpl_{uuid.uuid4().hex[:12]}",
                "name": checked_name,
                "functions": checked_functions,
                "created_at": now,
                "updated_at": now,
            }
            self._templates.append(template)
            self._save()
            return template

    async def update(
        self, template_id: str, *, name: str | None = None, functions: list[dict] | None = None
    ) -> dict[str, Any]:
        async with self._lock:
            self._load()
            template = self.get(template_id)
            if template is None:
                raise KeyError(template_id)
            if name is not None:
                template["name"] = self._check_name(name, exclude_id=template_id)
            if functions is not None:
                template["functions"] = self._normalize_functions(functions)
            template["updated_at"] = self._now()
            self._save()
            return template

    async def delete(self, template_id: str) -> bool:
        async with self._lock:
            self._load()
            before = len(self._templates)
            self._templates = [t for t in self._templates if t["id"] != template_id]
            if len(self._templates) == before:
                return False
            self._save()
            return True

    # -- catalog annotation (display only — apply() never filters on this) --
    def list_annotated(self, catalog_ids: set[str] | None) -> list[dict[str, Any]]:
        """Every template with each function's live status against the
        current catalog: 'ok' | 'missing' | 'unknown' (catalog not scanned
        yet) plus up to 3 rename suggestions. This is cosmetic — it drives the
        UI's missing-badge/rename-suggestion and MCP's list_templates() view,
        but apply() always arms every saved function unconditionally and lets
        brain's own resolution be authoritative, exactly like arm_functions.
        """
        known = sorted(catalog_ids) if catalog_ids is not None else []
        out: list[dict[str, Any]] = []
        for t in self._templates:
            annotated_functions = []
            for f in t["functions"]:
                if catalog_ids is None:
                    status, suggestions = "unknown", []
                elif f["id"] in catalog_ids:
                    status, suggestions = "ok", []
                else:
                    status = "missing"
                    suggestions = difflib.get_close_matches(f["id"], known, n=3, cutoff=0.5)
                annotated_functions.append({**f, "status": status, "suggestions": suggestions})
            out.append({**t, "functions": annotated_functions})
        return out

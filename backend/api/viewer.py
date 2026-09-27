"""backend/api/viewer.py — the "Brain Terminal" collector.

The target project (brain) runs as its own server with
``app/core/telemetry.py`` enabled. It streams trace events here; this
router fans them out to connected dashboards over a WebSocket and proxies
the two things a dashboard needs brain to do:

  * **apply a selection** — the user searches brain's functions (from
    this explorer's static AST scan), picks some (each shallow or deep),
    hits Apply; we forward the set to brain's
    ``POST /__telemetry__/instrument`` which arms them via
    ``sys.monitoring``.
  * **get a full value** / **run a test request** — proxied to brain.

The catalogue at ``GET /viewer/terminal/functions`` is this explorer's
scan of brain's source (every function/method, no imports).
``POST /viewer/terminal/rescan`` refreshes it after brain's code changes.

Everything is in-memory and unauthenticated — localhost dev only.
"""

from __future__ import annotations

import asyncio
import json
import time
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

from backend.analysis.templates import TemplateStore, TemplateValidationError
from backend.state import ExplorerState

router = APIRouter()


def get_state(request: Request) -> ExplorerState:
    return request.app.state.explorer_state


def get_template_store(request: Request) -> TemplateStore:
    return request.app.state.template_store


def _catalog_id_set(request: Request) -> set[str]:
    """Every function/method id ('module:QualName') in the current source
    scan — used only to annotate templates as ok/missing, never to gate
    what apply() sends to brain."""
    scan = get_state(request).scan_result
    ids: set[str] = set()
    for module in scan.modules:
        for fn in module.functions:
            ids.add(f"{module.module}:{fn.name}")
        for cls in module.classes:
            for method in cls.methods:
                ids.add(f"{module.module}:{cls.name}.{method.name}")
    return ids


# The built React dashboard (``cd frontend && npm run build``). In dev the
# frontend is served by Vite instead; this route is just a convenience so a
# single ``npm run build`` makes the tool self-hosting.
_FRONTEND_DIR = Path(__file__).resolve().parent.parent.parent / "frontend"
TERMINAL_HTML_PATH = _FRONTEND_DIR / "dist" / "index.html"

# package roots that are never the target's business code
_NON_SOURCE_ROOTS = {"tests", "test", "scripts", "migrations", "alembic", "docs"}


class TelemetryHub:
    def __init__(self, tail: int = 4000) -> None:
        self.clients: set[WebSocket] = set()
        self.recent: deque[dict] = deque(maxlen=tail)
        self.brain_base_url: str | None = None
        self.registered_at: str | None = None
        self.brain_fingerprint: str | None = None
        # the last selection the dashboard applied — [{"id","deep"}]
        self.selection: list[dict[str, Any]] = []
        self.scan_fingerprint: str | None = None
        self.project_path: str | None = None  # set at startup; lets us compare brain's start time with the code on disk
        self.last_register_ts: float = 0.0
        self.stats = {"events_in": 0, "dropped_by_brain": 0, "registers": 0}

    # -- ingest --------------------------------------------------------
    def register(self, *, brain_base_url, started_at, code_fingerprint) -> None:
        cleaned = _clean_url(brain_base_url)
        if cleaned:
            self.brain_base_url = cleaned
        self.registered_at = started_at
        self.brain_fingerprint = code_fingerprint
        self.last_register_ts = time.time()
        self.stats["registers"] += 1

    async def ingest(self, events: list[dict], dropped: int = 0) -> None:
        self.stats["events_in"] += len(events)
        self.stats["dropped_by_brain"] += dropped
        for event in events:
            self.recent.append(event)
            await self.broadcast(event)

    # -- fan-out ------------------------------------------------------
    async def broadcast(self, message: dict) -> None:
        for ws in list(self.clients):
            try:
                await ws.send_json(message)
            except Exception:  # noqa: BLE001
                self.clients.discard(ws)

    async def send_one(self, ws: WebSocket, message: dict) -> None:
        try:
            await ws.send_json(message)
        except Exception:  # noqa: BLE001
            self.clients.discard(ws)


HUB = TelemetryHub()


# ─────────────────────────────────────────────────────────────────────────
# Pages, catalogue, status
# ─────────────────────────────────────────────────────────────────────────
@router.get("/viewer/terminal", response_class=HTMLResponse)
async def serve_terminal_viewer():
    if TERMINAL_HTML_PATH.exists():
        return FileResponse(TERMINAL_HTML_PATH, media_type="text/html")
    return HTMLResponse(
        "<h1>Brain Terminal frontend is not built</h1>"
        "<p>Run <code>cd frontend &amp;&amp; npm run build</code>, "
        "or use the Vite dev server (<code>npm run dev</code>).</p>",
        status_code=404,
    )


@router.get("/viewer/terminal/assets/{asset_path:path}")
async def serve_terminal_asset(asset_path: str):
    candidate = (_FRONTEND_DIR / "dist" / "assets" / asset_path).resolve()
    assets_root = (_FRONTEND_DIR / "dist" / "assets").resolve()
    if assets_root in candidate.parents and candidate.is_file():
        return FileResponse(candidate)
    return HTMLResponse("not found", status_code=404)


@router.get("/viewer/terminal/functions")
async def get_terminal_functions(request: Request):
    return JSONResponse(_scan_catalog(request))


@router.post("/viewer/terminal/rescan")
async def rescan_terminal_functions(request: Request):
    get_state(request).rescan()
    return JSONResponse(_scan_catalog(request))


@router.get("/viewer/terminal/status")
async def terminal_status():
    return {
        "brain_base_url": HUB.brain_base_url,
        "registered_at": HUB.registered_at,
        "brain_fingerprint": HUB.brain_fingerprint,
        "scan_fingerprint": HUB.scan_fingerprint,
        "code_in_sync": _code_in_sync(),
        "connected_dashboards": len(HUB.clients),
        "buffered_events": len(HUB.recent),
        "selection": HUB.selection,
        **HUB.stats,
    }


@router.get("/viewer/terminal/traces")
async def get_terminal_traces(
    limit: int = 50,
    function_id: str | None = None,
    request_id: str | None = None,
    kind: str | None = None,
):
    """Query recent telemetry events with optional filtering."""
    limit = max(1, min(limit, 500))
    events = list(HUB.recent)
    if request_id:
        events = [e for e in events if e.get("request_id") == request_id]
    if kind:
        events = [e for e in events if e.get("kind") == kind]
    if function_id:
        fid_lower = function_id.lower()
        events = [
            e
            for e in events
            if fid_lower in str(e.get("data", {}).get("fn_id", "")).lower()
            or fid_lower in str(e.get("data", {}).get("name", "")).lower()
        ]
    return JSONResponse(events[-limit:])


@router.post("/viewer/terminal/selection")
async def set_terminal_selection(payload: dict):
    """Set active function selections and push them to brain."""
    selections = payload.get("selections") or []
    HUB.selection = [{"id": s.get("id"), "deep": bool(s.get("deep"))} for s in selections if s.get("id")]
    if not HUB.brain_base_url:
        return JSONResponse({"ok": False, "armed": [], "unresolved": [], "error": "brain not registered"})
    result = await _push_selection(HUB.selection)
    await HUB.broadcast({"kind": "selection_applied", **result})
    return JSONResponse({"ok": True, **result})


@router.get("/viewer/terminal/selection")
async def get_terminal_selection():
    """The currently armed selection, plus whether brain is reachable to honour it."""
    return {"selection": HUB.selection, "brain_connected": HUB.brain_base_url is not None}


@router.post("/viewer/terminal/selection/update")
async def update_terminal_selection(payload: dict):
    """Incrementally change the armed set: ``add`` merges (re-adding an id updates
    its deep flag), ``remove`` drops ids, ``clear`` empties it. Unlike
    ``POST /selection`` this never wipes what the caller didn't mention."""
    current = {s["id"]: bool(s.get("deep")) for s in HUB.selection}
    if payload.get("clear"):
        current = {}
    for fid in payload.get("remove") or []:
        current.pop(str(fid).strip(), None)
    for s in payload.get("add") or []:
        if s.get("id"):
            current[str(s["id"]).strip()] = bool(s.get("deep"))
    HUB.selection = [{"id": fid, "deep": deep} for fid, deep in current.items()]
    if not HUB.brain_base_url:
        return JSONResponse({"ok": False, "selection": HUB.selection, "armed": [], "unresolved": [], "error": "brain not registered"})
    result = await _push_selection(HUB.selection)
    await HUB.broadcast({"kind": "selection_applied", **result})
    return JSONResponse({"ok": "error" not in result, "selection": HUB.selection, **result})


# ─────────────────────────────────────────────────────────────────────────
# Trace Templates — named, saved function groups (see backend/analysis/templates.py)
# ─────────────────────────────────────────────────────────────────────────
def _template_error_status(exc: TemplateValidationError) -> int:
    return 409 if "already exists" in str(exc) else 400


@router.get("/viewer/terminal/templates")
async def list_terminal_templates(request: Request):
    store = get_template_store(request)
    return JSONResponse({"templates": store.list_annotated(_catalog_id_set(request))})


@router.post("/viewer/terminal/templates")
async def create_terminal_template(request: Request, payload: dict):
    store = get_template_store(request)
    try:
        template = await store.create(payload.get("name"), payload.get("functions"))
    except TemplateValidationError as exc:
        return JSONResponse({"error": str(exc)}, status_code=_template_error_status(exc))
    return JSONResponse({"template": template}, status_code=201)


@router.put("/viewer/terminal/templates/{template_id}")
async def update_terminal_template(template_id: str, request: Request, payload: dict):
    store = get_template_store(request)
    try:
        template = await store.update(template_id, name=payload.get("name"), functions=payload.get("functions"))
    except KeyError:
        return JSONResponse({"error": "template not found"}, status_code=404)
    except TemplateValidationError as exc:
        return JSONResponse({"error": str(exc)}, status_code=_template_error_status(exc))
    return JSONResponse({"template": template})


@router.delete("/viewer/terminal/templates/{template_id}")
async def delete_terminal_template(template_id: str, request: Request):
    store = get_template_store(request)
    if not await store.delete(template_id):
        return JSONResponse({"error": "template not found"}, status_code=404)
    return JSONResponse({"ok": True})


@router.post("/viewer/terminal/templates/{template_id}/apply")
async def apply_terminal_template(template_id: str, request: Request):
    """Arm every function in the template with its saved deep/shallow mode.
    Pushes all of them unconditionally — exactly like set_terminal_selection
    and arm_functions — so brain's own resolution is the sole source of truth
    for what's unresolved. The local catalog never gates what gets sent here,
    it only drives the missing/rename-suggestion cosmetics in GET above."""
    store = get_template_store(request)
    template = store.get(template_id)
    if template is None:
        return JSONResponse({"error": "template not found"}, status_code=404)
    HUB.selection = [{"id": f["id"], "deep": bool(f["deep"])} for f in template["functions"]]
    if not HUB.brain_base_url:
        return JSONResponse({"ok": False, "selection": HUB.selection, "armed": [], "unresolved": [], "error": "brain not registered"})
    result = await _push_selection(HUB.selection)
    await HUB.broadcast({"kind": "selection_applied", **result})
    return JSONResponse({"ok": "error" not in result, "selection": HUB.selection, **result})


@router.post("/viewer/terminal/traces/clear")
async def clear_terminal_traces():
    dropped = len(HUB.recent)
    await _clear_buffer()
    return {"ok": True, "dropped": dropped}


@router.post("/viewer/terminal/request")
async def send_terminal_request(payload: dict):
    """Fire a request at brain (only the registered brain — never an arbitrary URL)
    and report which trace request_id(s) it produced."""
    if not HUB.brain_base_url:
        return JSONResponse({"ok": False, "error": "brain not registered"}, status_code=503)
    method = str(payload.get("method") or "GET").upper()
    path = str(payload.get("path") or "/")
    if not path.startswith("/") or "://" in path or path.startswith("//"):
        return JSONResponse({"ok": False, "error": "path must be a relative path starting with '/'"}, status_code=400)
    started = _now()
    outcome = await _http_request(
        method, f"{HUB.brain_base_url}{path}", payload.get("body"), payload.get("headers") or {}
    )
    await asyncio.sleep(0.4)  # let brain's batched spans reach ingest
    request_ids = _request_ids_since(started, outcome["headers"].get("x-request-id"))
    return JSONResponse({"ok": outcome["status"] is not None, "request_ids": request_ids, **outcome})


@router.get("/viewer/terminal/value/{request_id}/{span_id}/{field}")
async def get_terminal_span_value(request_id: str, span_id: str, field: str):
    """Fetch full value (input, result, or exc) for a specific span from brain."""
    if not HUB.brain_base_url:
        return JSONResponse({"error": "brain not registered"}, status_code=503)
    url = f"{HUB.brain_base_url}/__telemetry__/value/{request_id}/{span_id}/{field}?__trace=0"
    try:
        data = await _http_get_json(url)
        return JSONResponse({"span_id": span_id, "field": field, "value": data.get("value")})
    except urllib.error.HTTPError as exc:
        return JSONResponse({"error": _brain_error(exc)}, status_code=exc.code)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": _brain_error(exc)}, status_code=500)




def _scan_catalog(request: Request) -> dict[str, Any]:
    """Every function + method in brain's source, grouped by package,
    id = 'dotted.module:QualName' (what brain's monitor resolves)."""
    state = get_state(request)
    scan = state.scan_result
    HUB.scan_fingerprint = f"{scan.scanned_file_count}f/{sum(len(m.functions) + sum(len(c.methods) for c in m.classes) for m in scan.modules)}fn"

    groups: dict[str, list[dict[str, Any]]] = {}
    for module in scan.modules:
        head = module.module.split(".", 1)[0]
        if head in _NON_SOURCE_ROOTS or module.module in ("conftest",):
            continue
        package = ".".join(module.module.split(".")[:3]) or module.module
        bucket = groups.setdefault(package, [])
        for fn in module.functions:
            bucket.append(_fn_entry(module.module, fn, None))
        for cls in module.classes:
            for method in cls.methods:
                bucket.append(_fn_entry(module.module, method, cls.name))
    return {
        "fingerprint": HUB.scan_fingerprint,
        "groups": [
            {"package": pkg, "functions": sorted(fns, key=lambda e: e["id"])}
            for pkg, fns in sorted(groups.items())
            if fns
        ],
    }


def _fn_entry(module: str, fn: Any, class_name: str | None) -> dict[str, Any]:
    qualname = f"{class_name}.{fn.name}" if class_name else fn.name
    params = ", ".join(p.name for p in fn.parameters if p.name not in ("self", "cls"))
    return {
        "id": f"{module}:{qualname}",
        "name": qualname,
        "package": module,
        "signature": f"({params})",
        "doc": (fn.docstring or "").strip().split("\n")[0][:200],
        "is_async": fn.is_async,
        "file": fn.file_path,
        "line": fn.line_number,
    }


# ─────────────────────────────────────────────────────────────────────────
# Ingest (brain -> explorer)
# ─────────────────────────────────────────────────────────────────────────
@router.post("/viewer/terminal/ingest")
async def ingest(payload: dict):
    if payload.get("kind") == "register":
        # brain re-sends this handshake every ~30s; only surface a log line
        # the first time or when brain actually restarts (new started_at) —
        # the rest are silent heartbeats.
        is_new = payload.get("started_at") != HUB.registered_at
        HUB.register(
            brain_base_url=payload.get("brain_base_url"),
            started_at=payload.get("started_at"),
            code_fingerprint=payload.get("code_fingerprint"),
        )
        if is_new:
            await HUB.broadcast(
                {
                    "kind": "log",
                    "request_id": "system",
                    "ts": _now(),
                    "data": {"level": "info", "line": f"brain registered ({HUB.brain_base_url})"},
                }
            )
        await HUB.broadcast(_code_status_message())
        # re-arm whatever the dashboard last applied (brain restart / fresh connect)
        if HUB.selection:
            asyncio.create_task(_push_selection(HUB.selection))
        return {"ok": True, "registered": True}

    events = payload.get("events") or []
    await HUB.ingest(events, dropped=int(payload.get("dropped", 0) or 0))
    return {"ok": True, "received": len(events)}


# ─────────────────────────────────────────────────────────────────────────
# Dashboard socket
# ─────────────────────────────────────────────────────────────────────────
@router.websocket("/viewer/terminal/ws")
async def websocket_terminal_endpoint(websocket: WebSocket):
    await websocket.accept()
    HUB.clients.add(websocket)
    await HUB.send_one(websocket, _code_status_message())
    for event in list(HUB.recent)[-800:]:
        await HUB.send_one(websocket, event)

    try:
        while True:
            data = await websocket.receive_json()
            await _handle_client_op(websocket, data)
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        pass
    finally:
        HUB.clients.discard(websocket)


async def _handle_client_op(ws: WebSocket, data: dict) -> None:
    op = data.get("op")
    if op == "apply_selection":
        await _apply_selection(ws, data.get("selections") or [])
    elif op == "get_value":
        await _proxy_get_value(ws, data)
    elif op == "clear":
        await _clear_buffer()


async def _clear_buffer() -> None:
    """Drop the replay buffer so a dashboard refresh doesn't re-hydrate
    events the user just cleared, and tell every other connected dashboard
    to clear its view too."""
    HUB.recent.clear()
    await HUB.broadcast({"kind": "cleared"})


async def _apply_selection(ws: WebSocket, selections: list[dict]) -> None:
    HUB.selection = [{"id": s.get("id"), "deep": bool(s.get("deep"))} for s in selections if s.get("id")]
    if not HUB.brain_base_url:
        await HUB.send_one(ws, {"kind": "selection_applied", "armed": [], "unresolved": [], "error": "brain not registered"})
        return
    result = await _push_selection(HUB.selection)
    await HUB.broadcast({"kind": "selection_applied", **result})


async def _push_selection(selection: list[dict]) -> dict:
    # ?__trace=0 — brain's own telemetry middleware skips opening a trace for
    # this call, so arming a selection doesn't spam the stream with empty
    # /__telemetry__/instrument request groups (it re-pushes every handshake).
    url = f"{HUB.brain_base_url}/__telemetry__/instrument?__trace=0"
    try:
        return await _http_post_json(url, {"selections": selection})
    except Exception as exc:  # noqa: BLE001
        return {"armed": [], "unresolved": [], "error": f"{type(exc).__name__}: {exc}"}


async def _proxy_get_value(ws: WebSocket, data: dict) -> None:
    span_id, field, request_id = data.get("span_id"), data.get("field", "result"), data.get("request_id")
    reply: dict[str, Any] = {"kind": "value", "span_id": span_id, "field": field}
    if not HUB.brain_base_url or not request_id:
        reply["error"] = "brain not registered or request_id missing"
        await HUB.send_one(ws, reply)
        return
    url = f"{HUB.brain_base_url}/__telemetry__/value/{request_id}/{span_id}/{field}?__trace=0"
    try:
        reply["value"] = (await _http_get_json(url)).get("value")
    except Exception as exc:  # noqa: BLE001
        # sent as `error`, not `value`, so the dashboard keeps its preview
        reply["error"] = _brain_error(exc)
    await HUB.send_one(ws, reply)


# ─────────────────────────────────────────────────────────────────────────
# helpers
# ─────────────────────────────────────────────────────────────────────────
BRAIN_SEEN_WITHIN = 90.0  # brain re-registers about every 30 s; silence beyond this means it is gone


def brain_code() -> dict[str, Any]:
    """Is brain running the code that is on disk? (see analysis/coderun.py)"""
    connected = HUB.brain_base_url is not None and (time.time() - HUB.last_register_ts) < BRAIN_SEEN_WITHIN
    if not connected or not HUB.project_path:
        return {"state": "unknown", "connected": connected, "newer_files": 0, "newest_file": None}
    from backend.analysis.coderun import brain_code_status

    return {"connected": True, **brain_code_status(HUB.project_path, HUB.registered_at)}


def _code_in_sync() -> bool | None:
    state = brain_code()["state"]
    return None if state == "unknown" else state == "current"


def _code_status_message() -> dict[str, Any]:
    return {"kind": "code_status", "in_sync": _code_in_sync(), "brain": HUB.brain_fingerprint, "code": brain_code()}


def _brain_error(exc: Exception) -> str:
    """Human-readable reason for a failed brain call. For an HTTP error, use
    brain's own ``detail`` (e.g. a 404 "request not in the recent ring buffer",
    meaning brain restarted or has since recorded 32+ newer requests)."""
    if isinstance(exc, urllib.error.HTTPError):
        try:
            detail = json.loads(exc.read().decode("utf-8", "replace")).get("detail")
        except Exception:  # noqa: BLE001
            detail = None
        return f"brain returned {exc.code}: {detail or exc.reason}"
    return f"{type(exc).__name__}: {exc}"


async def _http_get_json(url: str, timeout: float = 5.0) -> dict:
    def _do() -> dict:
        req = urllib.request.Request(url, headers={"accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - localhost dev only
            return json.loads(resp.read().decode("utf-8"))

    return await asyncio.to_thread(_do)


async def _http_post_json(url: str, body: dict, timeout: float = 10.0) -> dict:
    def _do() -> dict:
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, method="POST", headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - localhost dev only
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}

    return await asyncio.to_thread(_do)


async def _http_request(method: str, url: str, body: Any, headers: dict, timeout: float = 30.0) -> dict:
    def _do() -> dict:
        data = None
        hdrs = {"accept": "application/json", **{str(k): str(v) for k, v in headers.items()}}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            hdrs.setdefault("content-type", "application/json")
        req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - registered brain only
                status, raw, rh = resp.status, resp.read(), dict(resp.headers)
        except urllib.error.HTTPError as exc:
            status, raw, rh = exc.code, exc.read(), dict(exc.headers)
        except Exception as exc:  # noqa: BLE001
            return {"status": None, "headers": {}, "body": None, "error": f"{type(exc).__name__}: {exc}"}
        text = raw.decode("utf-8", "replace")
        try:
            parsed: Any = json.loads(text)
        except ValueError:
            parsed = text[:20000]
        return {"status": status, "headers": {k.lower(): v for k, v in rh.items()}, "body": parsed}

    return await asyncio.to_thread(_do)


def _request_ids_since(ts: float, header_id: str | None) -> list[str]:
    if header_id:
        return [header_id]
    seen: list[str] = []
    for e in HUB.recent:
        rid = e.get("request_id")
        if rid and rid != "system" and (e.get("ts") or 0) >= ts and rid not in seen:
            seen.append(rid)
    return seen


def _now() -> float:
    import time

    return time.time()


def _clean_url(value: Any) -> str | None:
    """Tolerate a base URL that arrived with a trailing inline comment or
    stray whitespace (e.g. ``set VAR=http://host  # note`` on Windows keeps
    the note in the value). Cut at the first whitespace or ``#`` and trim a
    trailing slash. Returns None for anything that doesn't look like http(s)."""
    if not value or not isinstance(value, str):
        return None
    head = value.strip().split("#", 1)[0].split()[0] if value.strip() else ""
    head = head.rstrip("/")
    return head if head.startswith(("http://", "https://")) else None

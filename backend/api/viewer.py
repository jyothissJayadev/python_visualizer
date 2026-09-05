"""backend/api/viewer.py — the "Brain Terminal" collector.

This is the receiving half of the decoupled telemetry path. The target
project (brain) runs as its own normal server with
``app/core/telemetry.py`` enabled; that module instruments its own
functions and POSTs a stream of trace events here. This router:

  * ``POST /viewer/terminal/ingest`` — accepts event batches and the
    startup ``register`` handshake from brain.
  * ``WS /viewer/terminal/ws`` — fans every event out to the connected
    dashboards, honouring each socket's selected-function / verbosity
    filter, and proxies the two callbacks a dashboard can make:
    ``get_value`` (fetch a call's full I/O from brain's ring buffer) and
    ``run_test`` (drive one of brain's own dev chat/extraction routes).
  * ``GET /viewer/terminal`` — serves ``frontend/terminal.html``.
  * ``GET /viewer/terminal/functions`` — the function catalogue, from
    brain's handshake (falling back to a scan of the target, then a
    static demo catalogue).

Everything is in-memory and unauthenticated — same localhost-only,
no-persistence posture as the rest of the explorer. This is separate from
the ``sys.monitoring`` hosted-app tracer in ``backend/tracer/``; that one
still serves ``/api/traces`` unchanged.
"""

from __future__ import annotations

import asyncio
import json
import urllib.request
from collections import deque
from pathlib import Path
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

router = APIRouter()

TERMINAL_HTML_PATH = Path(__file__).resolve().parent.parent.parent / "frontend" / "terminal.html"

# Event kinds that a per-socket "selected functions only" filter applies
# to; request envelopes / logs / value replies always pass through.
_FILTERABLE = {"fn.start", "fn.end", "fn.error", "llm.call"}

# domain -> (brain route, body mode) for the dashboard's "run test request".
# brain's /viewer/* routes are deliberately unauthenticated (see brain's
# app/admin/viewer_router.py), so no internal key is needed.
_DOMAIN_ROUTES: dict[str, tuple[str, str]] = {
    "quotation": ("/viewer/quotation/chat", "chat"),
    "execution": ("/viewer/execution/chat", "chat"),
    "quotation_edit": ("/viewer/quotation_edit/chat", "chat"),
    "extraction": ("/viewer/extraction/run", "extraction"),
}


class _Client:
    """One connected dashboard socket and its view filter."""

    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws
        self.selected: set[str] = set()
        self.verbosity = "all"  # "all" | "selected" — until the client says otherwise

    def wants(self, event: dict) -> bool:
        if event.get("kind") not in _FILTERABLE or self.verbosity == "all":
            return True
        return (event.get("data") or {}).get("name") in self.selected


class TelemetryHub:
    def __init__(self, tail: int = 3000) -> None:
        self.clients: dict[WebSocket, _Client] = {}
        self.recent: deque[dict] = deque(maxlen=tail)
        self.brain_base_url: str | None = None
        self.catalog: dict | None = None
        self.registered_at: str | None = None
        self.stats = {"events_in": 0, "dropped_by_brain": 0, "registers": 0}

    # -- ingest side --------------------------------------------------------
    def register(self, *, brain_base_url: str | None, catalog: dict | None, started_at: str | None) -> None:
        if brain_base_url:
            self.brain_base_url = brain_base_url.rstrip("/")
        if catalog and catalog.get("groups"):
            self.catalog = catalog
        self.registered_at = started_at
        self.stats["registers"] += 1

    async def ingest(self, events: list[dict], dropped: int = 0) -> None:
        self.stats["events_in"] += len(events)
        self.stats["dropped_by_brain"] += dropped
        for event in events:
            self.recent.append(event)
            await self.broadcast(event)

    # -- fan-out side -----------------------------------------------------
    async def broadcast(self, event: dict) -> None:
        for ws, client in list(self.clients.items()):
            if not client.wants(event):
                continue
            try:
                await ws.send_json(event)
            except Exception:  # noqa: BLE001 — socket gone; reap it
                self.clients.pop(ws, None)

    async def send_one(self, ws: WebSocket, message: dict) -> None:
        try:
            await ws.send_json(message)
        except Exception:  # noqa: BLE001
            self.clients.pop(ws, None)


HUB = TelemetryHub()


# ─────────────────────────────────────────────────────────────────────────
# Pages & catalogue
# ─────────────────────────────────────────────────────────────────────────
@router.get("/viewer/terminal", response_class=HTMLResponse)
async def serve_terminal_viewer():
    if TERMINAL_HTML_PATH.exists():
        return FileResponse(TERMINAL_HTML_PATH, media_type="text/html")
    return HTMLResponse("<h1>frontend/terminal.html not found</h1>", status_code=404)


@router.get("/viewer/terminal/status")
async def terminal_status():
    return {
        "brain_base_url": HUB.brain_base_url,
        "registered_at": HUB.registered_at,
        "connected_dashboards": len(HUB.clients),
        "buffered_events": len(HUB.recent),
        "catalog_functions": sum(len(g.get("functions", [])) for g in (HUB.catalog or {}).get("groups", [])),
        **HUB.stats,
    }


@router.get("/viewer/terminal/functions")
async def get_terminal_functions():
    if HUB.catalog and HUB.catalog.get("groups"):
        return JSONResponse(HUB.catalog)
    return JSONResponse(_DEMO_CATALOG)


# ─────────────────────────────────────────────────────────────────────────
# Ingest (brain -> explorer)
# ─────────────────────────────────────────────────────────────────────────
@router.post("/viewer/terminal/ingest")
async def ingest(payload: dict):
    kind = payload.get("kind")
    if kind == "register":
        HUB.register(
            brain_base_url=payload.get("brain_base_url"),
            catalog=payload.get("catalog"),
            started_at=payload.get("started_at"),
        )
        await HUB.broadcast(
            {
                "kind": "log",
                "request_id": "system",
                "ts": _now(),
                "data": {"level": "info", "line": f"brain registered ({HUB.brain_base_url})"},
            }
        )
        return {"ok": True, "registered": True, "functions": _catalog_size()}

    events = payload.get("events") or []
    await HUB.ingest(events, dropped=int(payload.get("dropped", 0) or 0))
    return {"ok": True, "received": len(events)}


# ─────────────────────────────────────────────────────────────────────────
# Dashboard socket (explorer -> browser, + browser callbacks)
# ─────────────────────────────────────────────────────────────────────────
@router.websocket("/viewer/terminal/ws")
async def websocket_terminal_endpoint(websocket: WebSocket):
    await websocket.accept()
    client = _Client(websocket)
    HUB.clients[websocket] = client

    # Replay the recent tail so a dashboard opened mid-flight still sees
    # in-progress requests rather than a blank screen.
    for event in list(HUB.recent)[-800:]:
        await HUB.send_one(websocket, event)

    try:
        while True:
            data = await websocket.receive_json()
            await _handle_client_op(client, data)
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 — never let one bad frame kill the socket loop uncleanly
        pass
    finally:
        HUB.clients.pop(websocket, None)


async def _handle_client_op(client: _Client, data: dict) -> None:
    op = data.get("op")
    if op == "select":
        client.selected = set(data.get("functions") or [])
    elif op == "set_verbosity":
        client.verbosity = data.get("level", "all")
    elif op == "get_value":
        await _proxy_get_value(client, data)
    elif op == "run_test":
        await _run_test(client, data)


async def _proxy_get_value(client: _Client, data: dict) -> None:
    span_id = data.get("span_id")
    field = data.get("field", "result")
    request_id = data.get("request_id")
    reply: dict[str, Any] = {"kind": "value", "span_id": span_id, "field": field}

    if not HUB.brain_base_url or not request_id:
        reply["value"] = {"error": "brain not registered or request_id missing"}
        await HUB.send_one(client.ws, reply)
        return

    url = f"{HUB.brain_base_url}/__telemetry__/value/{request_id}/{span_id}/{field}"
    try:
        body = await _http_get_json(url)
        reply["value"] = body.get("value")
    except Exception as exc:  # noqa: BLE001
        reply["value"] = {"error": f"{type(exc).__name__}: {exc}"}
    await HUB.send_one(client.ws, reply)


async def _run_test(client: _Client, data: dict) -> None:
    async def log(level: str, line: str) -> None:
        await HUB.send_one(
            client.ws,
            {"kind": "log", "request_id": "system", "ts": _now(), "data": {"level": level, "line": line}},
        )

    if not HUB.brain_base_url:
        await log("error", "no brain has registered yet — start brain with BRAIN_TELEMETRY_ENABLED=1")
        return

    domain = data.get("domain", "quotation")
    route, mode = _DOMAIN_ROUTES.get(domain, _DOMAIN_ROUTES["quotation"])
    url = HUB.brain_base_url + route
    if mode == "extraction":
        req_body = {"raw_text": data.get("message", "")}
    else:
        req_body = {"message": data.get("message", ""), "session_id": data.get("session_id") or None}

    await log("info", f"POST {url}")
    try:
        status = await _http_post_drain(url, req_body)
        await log("info", f"test request finished ({status}) — watch the stream for its trace")
    except Exception as exc:  # noqa: BLE001
        await log("error", f"test request failed: {type(exc).__name__}: {exc}")


# ─────────────────────────────────────────────────────────────────────────
# Tiny stdlib HTTP client (no new dependency; low-frequency dev calls)
# ─────────────────────────────────────────────────────────────────────────
async def _http_get_json(url: str, timeout: float = 5.0) -> dict:
    def _do() -> dict:
        request = urllib.request.Request(url, headers={"accept": "application/json"})
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - localhost dev only
            return json.loads(response.read().decode("utf-8"))

    return await asyncio.to_thread(_do)


async def _http_post_drain(url: str, body: dict, timeout: float = 180.0) -> int:
    """POST JSON and read the response to EOF (brain's viewer chat routes
    stream SSE — we don't need the body, the trace arrives via ingest).
    Returns the HTTP status."""

    def _do() -> int:
        payload = json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            url, data=payload, method="POST", headers={"content-type": "application/json"}
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - localhost dev only
            for _ in response:
                pass
            return response.status

    return await asyncio.to_thread(_do)


def _now() -> float:
    import time

    return time.time()


def _catalog_size() -> int:
    return sum(len(g.get("functions", [])) for g in (HUB.catalog or {}).get("groups", []))


# ─────────────────────────────────────────────────────────────────────────
# Fallback catalogue (shown before brain registers / when running detached)
# ─────────────────────────────────────────────────────────────────────────
_DEMO_CATALOG: dict[str, Any] = {
    "groups": [
        {
            "package": "quotation.extraction",
            "functions": [
                {
                    "id": "quotation.extraction.pipeline:run_pipeline",
                    "name": "run_pipeline",
                    "signature": "(raw_text: str, *, domain: str)",
                    "doc": "Executes the multi-stage extraction pipeline over raw text.",
                },
                {
                    "id": "quotation.extraction.pipeline:_process_chunk",
                    "name": "_process_chunk",
                    "signature": "(chunk, *, ontology, domain)",
                    "doc": "Processes one segment and maps it to domain entities.",
                },
            ],
        },
        {
            "package": "quotation.graph",
            "functions": [
                {
                    "id": "quotation.graph.resolution.resolve:resolve_entities",
                    "name": "resolve_entities",
                    "signature": "(entities, *, domain)",
                    "doc": "Concept resolution against the ontology graph.",
                },
            ],
        },
        {
            "package": "core.llm",
            "functions": [
                {
                    "id": "core.llm.client:LLMClient.generate_structured_json",
                    "name": "LLMClient.generate_structured_json",
                    "signature": "(self, model, messages, schema)",
                    "doc": "Structured JSON completion.",
                },
            ],
        },
    ]
}

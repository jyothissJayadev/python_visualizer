"""Background sender: hub events -> ``<sink>/viewer/terminal/ingest`` plus a periodic ``register``
handshake (so a collector restart re-arms the selection). Never blocks the target: the queue
drops oldest when the collector is down."""
from __future__ import annotations

import asyncio
import hashlib
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from . import trace

_QUEUE_MAX = 10_000
_BATCH_MAX = 100
_HTTP_TIMEOUT = 3.0


def code_fingerprint(project_root: Path, package_root: Path) -> str:
    try:
        sha = subprocess.run(["git", "-C", str(project_root), "rev-parse", "HEAD"],
                             capture_output=True, text=True, timeout=3)
        if sha.returncode == 0 and sha.stdout.strip():
            return f"git:{sha.stdout.strip()[:12]}"
    except Exception:  # noqa: BLE001
        pass
    digest = hashlib.sha1()
    for root, _dirs, files in os.walk(package_root):
        for name in sorted(f for f in files if f.endswith(".py")):
            path = os.path.join(root, name)
            try:
                digest.update(path.encode("utf-8", "replace"))
                digest.update(str(os.path.getmtime(path)).encode("ascii"))
            except OSError:
                pass
    return f"mtime:{digest.hexdigest()[:12]}"


def _reraise_if_cancelling() -> None:
    """httpx/anyio can turn our task's cancellation into an ordinary exception. Swallowing it
    would consume the one cancel() the event loop sends at shutdown and leave the task (and
    the whole shutdown) hanging, so re-raise when a cancellation is pending."""
    task = asyncio.current_task()
    if task is not None and task.cancelling():
        raise asyncio.CancelledError


class Sink:
    def __init__(self, *, sink_url: str, self_url: str, project_root: Path, package_root: Path,
                 register_interval_s: float = 30.0, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._ingest_url = f"{sink_url}/viewer/terminal/ingest"
        self._self_url = self_url
        self._project_root, self._package_root = project_root, package_root
        self._interval = register_interval_s
        self._transport = transport
        self._out: asyncio.Queue[dict] = asyncio.Queue(maxsize=_QUEUE_MAX)
        self._dropped = 0
        self._sent = 0
        self._tasks: list[asyncio.Task] = []
        self._hub_queue: asyncio.Queue | None = None
        self._fingerprint: str | None = None

    def start(self) -> None:
        loop = asyncio.get_running_loop()
        self._hub_queue = trace.hub().subscribe(loop)
        self._tasks = [asyncio.create_task(self._pump(), name="viz-pump"),
                       asyncio.create_task(self._sender(), name="viz-sender"),
                       asyncio.create_task(self._register_loop(), name="viz-register")]

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        if self._hub_queue is not None:
            trace.hub().unsubscribe(self._hub_queue)

    def stats(self) -> dict[str, int]:
        return {"queued": self._out.qsize(), "sent": self._sent, "dropped": self._dropped}

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=_HTTP_TIMEOUT, transport=self._transport)

    async def _pump(self) -> None:
        assert self._hub_queue is not None
        while True:
            event = await self._hub_queue.get()
            while True:
                try:
                    self._out.put_nowait(event)
                    break
                except asyncio.QueueFull:
                    try:
                        self._out.get_nowait()
                        self._dropped += 1
                    except asyncio.QueueEmpty:
                        break

    # NOTE: the clients below are deliberately not used as ``async with``. Awaiting the client's
    # ``aclose()`` while the task is being cancelled (server shutdown, loop teardown) can hang,
    # and a hung telemetry task must never block the target's shutdown.
    async def _sender(self) -> None:
        client = self._client()
        while True:
            batch = [await self._out.get()]
            while len(batch) < _BATCH_MAX:
                try:
                    batch.append(self._out.get_nowait())
                except asyncio.QueueEmpty:
                    break
            body: dict[str, Any] = {"kind": "events", "events": batch}
            if self._dropped:
                body["dropped"], self._dropped = self._dropped, 0
            try:
                await client.post(self._ingest_url, json=body)
                self._sent += len(batch)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - collector down: drop, keep serving
                _reraise_if_cancelling()

    async def register_once(self, client: httpx.AsyncClient) -> None:
        if self._fingerprint is None:
            self._fingerprint = await asyncio.to_thread(code_fingerprint, self._project_root, self._package_root)
        await client.post(self._ingest_url, json={
            "kind": "register", "brain_base_url": self._self_url,
            "started_at": self._started_at, "code_fingerprint": self._fingerprint})

    _started_at = datetime.now(timezone.utc).isoformat()

    async def _register_loop(self) -> None:
        client = self._client()
        while True:
            try:
                await self.register_once(client)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                _reraise_if_cancelling()
            await asyncio.sleep(self._interval)

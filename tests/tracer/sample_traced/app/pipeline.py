"""Async side of the synthetic target — exercises tracing across `await`,
which is the case plain sys.setprofile can't handle cleanly."""

from __future__ import annotations

import asyncio

from app.calc import add, scale


async def fetch(n: int) -> int:
    await asyncio.sleep(0)
    return n * 10


async def stage(n: int) -> int:
    raw = await fetch(n)
    await asyncio.sleep(0)
    return add(raw, 1)


async def run_pipeline(items: list[int]) -> dict[str, int]:
    total = 0
    for item in items:
        total += await stage(item)
    return {"count": len(items), "total": scale(total, 1)}

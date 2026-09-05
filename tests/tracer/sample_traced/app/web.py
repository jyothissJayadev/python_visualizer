"""A tiny FastAPI app the hosted-middleware test mounts and drives."""

from __future__ import annotations

from fastapi import FastAPI, Header, HTTPException

from app.calc import guarded
from app.pipeline import run_pipeline

app = FastAPI()


@app.get("/compute/{x}")
async def compute(x: int) -> dict:
    return {"result": guarded(x)}


@app.post("/pipeline")
async def pipeline(items: list[int]) -> dict:
    return await run_pipeline(items)


@app.get("/secured")
async def secured(x_internal_api_key: str = Header(default="")) -> dict:
    if x_internal_api_key != "s3cret":
        raise HTTPException(status_code=401, detail="nope")
    return {"ok": True}

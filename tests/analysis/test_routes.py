from __future__ import annotations

from pathlib import Path

from backend.analysis.routes import discover_routes


def _write(root: Path, files: dict[str, str]) -> None:
    for rel, src in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(src, encoding="utf-8")


def test_prefix_chain_factory_and_nested_handler(tmp_path: Path):
    _write(tmp_path, {
        "app/__init__.py": "",
        "app/factory.py": (
            "from fastapi import APIRouter\n"
            "def build(*, get_thing, undo=None):\n"
            "    r = APIRouter()\n"
            "    @r.get('/{id}')\n"
            "    async def _get(id: str):\n"
            "        return await get_thing(id)\n"
            "    if undo is not None:\n"
            "        @r.post('/undo')\n"
            "        async def _undo(): ...\n"
            "    return r\n"
        ),
        "app/things.py": (
            "from fastapi import APIRouter, Depends\n"
            "from app.factory import build\n"
            "def get_thing(i): ...\n"
            "def dep(): ...\n"
            "router = APIRouter(dependencies=[Depends(dep)])\n"
            "router.include_router(build(get_thing=get_thing), prefix='/t')\n"
            "@router.get('/list')\n"
            "def list_things(): ...\n"
        ),
        "app/main.py": (
            "from fastapi import FastAPI\n"
            "from app import things\n"
            "from app.things import router as things_router\n"
            "def create_app():\n"
            "    app = FastAPI()\n"
            "    app.include_router(things_router, prefix='/api')\n"
            "    @app.get('/health')\n"
            "    def health(): ...\n"
            "    return app\n"
        ),
    })
    result = discover_routes(str(tmp_path))
    by_id = {e.id: e for e in result.endpoints}
    assert set(by_id) == {"GET /api/list", "GET /api/t/{id}", "GET /health"}  # undo not passed -> skipped
    assert by_id["GET /api/list"].dependencies == ["dep"]
    assert by_id["GET /health"].handler_id == "app.main:create_app.<locals>.health"
    t = by_id["GET /api/t/{id}"]
    assert t.handler_id == "app.factory:build.<locals>._get"
    assert t.bindings == {"get_thing": "app.things:get_thing"}
    assert result.unmounted == []


def test_unmounted_router_and_param_app(tmp_path: Path):
    _write(tmp_path, {
        "app/__init__.py": "",
        "app/orphan.py": "from fastapi import APIRouter\nr = APIRouter()\n@r.get('/x')\ndef x(): ...\n",
        "app/tele.py": (
            "from fastapi import APIRouter, FastAPI\n"
            "r = APIRouter()\n"
            "@r.get('/t')\n"
            "def t(): ...\n"
            "def setup(app: FastAPI):\n"
            "    app.include_router(r)\n"
        ),
    })
    result = discover_routes(str(tmp_path))
    assert [e.id for e in result.endpoints] == ["GET /t"]
    assert result.endpoints[0].param_app is True
    assert [u.id for u in result.unmounted] == ["app.orphan:r"]

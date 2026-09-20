from __future__ import annotations

from pathlib import Path

from backend.analysis.engine import Analysis


def _write(root: Path, files: dict[str, str]) -> None:
    for rel, src in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(src, encoding="utf-8")


def _walk(node: dict):
    yield node
    for c in node.get("children", []):
        yield from _walk(c)


def _names(node: dict, kind: str | None = None) -> list[str]:
    return [n["name"] for n in _walk(node) if kind is None or n["kind"] == kind]


def _analyze(tmp_path: Path, files: dict[str, str], endpoint: str) -> dict:
    _write(tmp_path, {"app/__init__.py": "", **files})
    tree = Analysis(str(tmp_path)).tree(endpoint)
    assert tree is not None, "endpoint not discovered"
    return tree


def test_factory_binding_and_closure_resolution(tmp_path: Path):
    tree = _analyze(tmp_path, {
        "app/factory.py": (
            "from fastapi import APIRouter\n"
            "def build(*, fetch):\n"
            "    r = APIRouter()\n"
            "    @r.get('/{id}')\n"
            "    async def _get(id: str):\n"
            "        async def inner():\n"
            "            return await fetch(id)\n"
            "        return await inner()\n"
            "    return r\n"
        ),
        "app/svc.py": "async def fetch_thing(i):\n    return helper(i)\ndef helper(i):\n    return i\n",
        "app/main.py": (
            "from fastapi import FastAPI\n"
            "from app.factory import build\n"
            "from app.svc import fetch_thing\n"
            "app = FastAPI()\n"
            "app.include_router(build(fetch=fetch_thing), prefix='/t')\n"
        ),
    }, "GET /t/{id}")
    fn = {n["function_id"] for n in _walk(tree["root"]) if n["kind"] == "function"}
    assert "app.svc:fetch_thing" in fn and "app.svc:helper" in fn
    assert tree["stats"]["unresolved"] == 0


def test_protocol_dispatch_uses_bound_instance(tmp_path: Path):
    tree = _analyze(tmp_path, {
        "app/adapters.py": (
            "from typing import Protocol\n"
            "class Adapter(Protocol):\n"
            "    async def run(self, x): ...\n"
            "class A:\n"
            "    async def run(self, x):\n"
            "        return a_impl(x)\n"
            "class B:\n"
            "    async def run(self, x):\n"
            "        return b_impl(x)\n"
            "def a_impl(x): ...\n"
            "def b_impl(x): ...\n"
        ),
        "app/main.py": (
            "from fastapi import FastAPI\n"
            "from app.adapters import Adapter, A\n"
            "def make(adapter: Adapter):\n"
            "    async def go(x):\n"
            "        return await adapter.run(x)\n"
            "    return go\n"
            "app = FastAPI()\n"
            "go = make(A())\n"
            "@app.get('/a')\n"
            "async def a_route():\n"
            "    return await go(1)\n"
            "@app.get('/unbound')\n"
            "async def unbound(adapter: Adapter):\n"
            "    return await adapter.run(1)\n"
        ),
    }, "GET /unbound")
    # unbound Protocol param -> dispatch fan-out over both implementations
    assert "dispatch" in {n["kind"] for n in _walk(tree["root"])}
    assert {"app.adapters:A.run", "app.adapters:B.run"} <= {n.get("function_id") for n in _walk(tree["root"])}


def test_control_flow_markers_depends_spawn_cycles_and_local_imports(tmp_path: Path):
    tree = _analyze(tmp_path, {
        "app/util.py": "def leaf(): ...\ndef rec(n):\n    return rec(n - 1) if n else leaf()\n",
        "app/main.py": (
            "import asyncio\n"
            "from fastapi import FastAPI, Depends\n"
            "app = FastAPI()\n"
            "def auth(): ...\n"
            "async def job(x): ...\n"
            "@app.get('/x')\n"
            "async def x(user=Depends(auth), items=[1]):\n"
            "    from app.util import leaf, rec\n"
            "    for i in items:\n"
            "        leaf()\n"
            "    if user:\n"
            "        rec(3)\n"
            "    else:\n"
            "        leaf()\n"
            "    try:\n"
            "        await asyncio.gather(*(job(i) for i in items))\n"
            "    except Exception:\n"
            "        leaf()\n"
        ),
    }, "GET /x")
    kinds = {n["kind"] for n in _walk(tree["root"])}
    assert {"loop", "branch", "arm"} <= kinds
    edges = {(n["name"], n.get("edge")) for n in _walk(tree["root"]) if n["kind"] == "function"}
    assert ("auth", "depends") in edges
    assert ("job", "spawn") in edges
    assert any(n.get("cyclic") for n in _walk(tree["root"]))  # rec -> rec
    assert tree["stats"]["cyclic"] == 1


def test_langgraph_builder_is_expanded_at_run_site(tmp_path: Path):
    tree = _analyze(tmp_path, {
        "app/graph.py": (
            "from langgraph.graph import END, StateGraph\n"
            "def build_graph(adapter):\n"
            "    g = StateGraph(dict)\n"
            "    async def a(state):\n"
            "        return await adapter.think(state)\n"
            "    async def b(state):\n"
            "        return state\n"
            "    def route(state):\n"
            "        return 'b'\n"
            "    g.add_node('a', a)\n"
            "    g.add_node('b', b)\n"
            "    g.set_entry_point('a')\n"
            "    g.add_conditional_edges('a', route, {'b': 'b', 'stop': END})\n"
            "    g.add_edge('b', END)\n"
            "    return g.compile()\n"
        ),
        "app/impl.py": "class Impl:\n    async def think(self, s):\n        return deep(s)\ndef deep(s): ...\n",
        "app/main.py": (
            "from fastapi import FastAPI\n"
            "from app.graph import build_graph\n"
            "from app.impl import Impl\n"
            "compiled = build_graph(Impl())\n"
            "app = FastAPI()\n"
            "@app.post('/run')\n"
            "async def run():\n"
            "    return await compiled.ainvoke({})\n"
        ),
    }, "POST /run")
    graph = next(n for n in _walk(tree["root"]) if n["kind"] == "graph")
    assert [c.get("label") for c in graph["children"]] == ["a", "route after a", "b"]
    a = graph["children"][0]
    assert a["meta"]["graph"]["next"] == [{"to": "b", "label": "b"}, {"to": "__end__", "label": "stop"}]
    assert "app.impl:deep" in {n.get("function_id") for n in _walk(a)}  # adapter bound through the graph

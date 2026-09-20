from __future__ import annotations

from pathlib import Path

from backend.analysis.callgraph import render
from backend.analysis.engine import Analysis
from backend.analysis.funcview import function_view, view_stats

FILES = {
    "app/__init__.py": "",
    "app/util.py": (
        "import json\n"
        "class Plain:\n"
        "    pass\n"
        "class Box:\n"
        "    def __init__(self, x): self.x = x\n"
        "def leaf(x):\n"
        "    return json.dumps(x)\n"
        "def helper(x):\n"
        "    return leaf(x)\n"
        "def rec(n):\n"
        "    return rec(n - 1) if n else leaf(n)\n"
    ),
    "app/main.py": (
        "import os\n"
        "from fastapi import FastAPI\n"
        "from app.util import helper, leaf, rec, Box, Plain\n"
        "app = FastAPI()\n"
        "@app.get('/x')\n"
        "async def x(items=[1, 2]):\n"
        "    for i in items:\n"
        "        helper(i)\n"
        "    if items:\n"
        "        helper(0)\n"
        "        leaf(1)\n"
        "    else:\n"
        "        os.getenv('A')\n"
        "    try:\n"
        "        rec(3)\n"
        "    except Exception:\n"
        "        Box(1)\n"
        "        Plain(x='a long argument that must not leak into the name')\n"
        "    mystery.go()\n"
        "    os.getcwd()\n"
    ),
}


def _view(tmp_path: Path):
    for rel, src in FILES.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(src, encoding="utf-8")
    a = Analysis(str(tmp_path))
    full = a.callgraph.endpoint_root(a.endpoint("GET /x"))
    return full, function_view(full)


def test_only_functions_remain_and_control_flow_is_dissolved(tmp_path: Path):
    full, view = _view(tmp_path)
    tree = render(view, "0", None, "0")

    def walk(n):
        yield n
        for c in n.get("children", []):
            yield from walk(c)

    assert {n["kind"] for n in walk(tree)} == {"function"}
    # loop + if-branch + try arms are gone: helper/leaf/rec hang directly off the handler
    # (Box() is a user-defined __init__, so it is a function node too)
    assert [c["name"] for c in tree["children"]] == ["helper", "leaf", "rec", "Box()"]


def test_repeated_calls_merge_and_recursion_is_marked(tmp_path: Path):
    _, view = _view(tmp_path)
    tree = render(view, "0", None, "0")
    helper, leaf, rec, _box = tree["children"]
    assert helper["meta"]["count"] == 2  # called in the loop and in the if-branch
    assert "count" not in leaf.get("meta", {})
    assert rec["children"][0]["name"] == "rec" and rec["children"][0].get("cyclic")


def test_library_calls_move_to_the_parent_function(tmp_path: Path):
    _, view = _view(tmp_path)
    tree = render(view, "0", None, "0")
    lib = {(e["kind"], e["name"]) for e in tree["meta"]["library"]}
    assert ("external", "os.getenv") in lib and ("external", "os.getcwd") in lib
    assert ("class", "Plain()") in lib  # no __init__ -> a library-style entry (name only, no arguments)
    assert any(k == "unresolved" and "mystery.go" in n for k, n in lib)
    # the leaf function's own library call is on the leaf, not the handler
    leaf = next(c for c in tree["children"] if c["name"] == "leaf")
    assert "json.dumps" in {e["name"] for e in render(view.children[1], "0.1", 0, "0.1")["meta"]["library"]}
    assert leaf["meta"]["library_count"] == 1  # only a count unless it is the requested node


def test_stats_come_from_the_view_but_coverage_from_the_full_tree(tmp_path: Path):
    full, view = _view(tmp_path)
    s = view_stats(full, view)
    # x, helper, helper>leaf, leaf, rec, rec>rec (recursive marker), rec>leaf, Box()
    assert s["function"] == 8 and s["nodes"] == 8
    assert s["unresolved"] == 1 and s["external"] >= 3 and s["class"] == 1
    assert 0 < s["coverage"] < 1

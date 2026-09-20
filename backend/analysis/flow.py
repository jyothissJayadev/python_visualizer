"""backend/analysis/flow.py — turns a function body into an ordered list of
"steps": calls (in evaluation order), loops, branches/try-blocks, and
FastAPI ``Depends`` edges. Purely syntactic: name resolution happens later
(callgraph.py), because it depends on which arguments a caller bound.

  * loops: ``for`` / ``while`` / comprehensions & generator expressions
  * branches: ``if/elif/else``, ``try/except/else/finally``, ``match``
  * concurrency: calls passed to ``create_task`` / ``gather`` /
    ``ensure_future`` / ``to_thread`` / ... are tagged role="spawn"; bare
    function references passed to them become RefSteps (callbacks)
  * nested ``def``/``class``/``lambda`` bodies are NOT walked — their calls
    belong to the nested function, and appear when it is called
"""

from __future__ import annotations

import ast
from dataclasses import dataclass, field
from typing import Union

DISPATCHERS = {
    "create_task", "ensure_future", "gather", "to_thread", "run_in_executor", "submit",
    "add_task", "run_coroutine_threadsafe", "wait_for", "shield", "as_completed", "call_soon",
    "call_soon_threadsafe",
}


@dataclass
class CallStep:
    call: ast.Call
    awaited: bool
    role: str  # call | spawn

    @property
    def line(self) -> int:
        return self.call.lineno


@dataclass
class RefStep:
    expr: ast.expr
    role: str = "callback"

    @property
    def line(self) -> int:
        return self.expr.lineno


@dataclass
class DependsStep:
    expr: ast.expr
    line: int


@dataclass
class LoopStep:
    kind: str  # for | while | comprehension
    header: str
    line: int
    body: list["Step"] = field(default_factory=list)


@dataclass
class BranchStep:
    kind: str  # if | try | match
    line: int
    arms: list[tuple[str, list["Step"]]] = field(default_factory=list)


Step = Union[CallStep, RefStep, DependsStep, LoopStep, BranchStep]


def _short(text: str, n: int = 90) -> str:
    text = " ".join(text.split())
    return text if len(text) <= n else text[: n - 1] + "…"


def _last_name(expr: ast.expr) -> str | None:
    if isinstance(expr, ast.Name):
        return expr.id
    if isinstance(expr, ast.Attribute):
        return expr.attr
    return None


# ── expressions ──────────────────────────────────────────────────────────
def expr_steps(e: ast.AST | None, out: list[Step], awaited: bool = False, role: str = "call") -> None:
    if e is None:
        return
    if isinstance(e, ast.Await):
        expr_steps(e.value, out, True, role)
    elif isinstance(e, ast.Call):
        _call_steps(e, out, awaited, role)
    elif isinstance(e, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
        for gen in e.generators:
            expr_steps(gen.iter, out, False, role)
        inner: list[Step] = []
        for gen in e.generators:
            for cond in gen.ifs:
                expr_steps(cond, inner, False, role)
        if isinstance(e, ast.DictComp):
            expr_steps(e.key, inner, False, role)
            expr_steps(e.value, inner, False, role)
        else:
            expr_steps(e.elt, inner, False, role)
        if inner:
            gen0 = e.generators[0]
            header = f"for {ast.unparse(gen0.target)} in {ast.unparse(gen0.iter)}"
            out.append(LoopStep("comprehension", _short(header), e.lineno, inner))
    elif isinstance(e, (ast.Lambda, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return
    elif isinstance(e, (ast.expr, ast.keyword, ast.comprehension)):
        for child in ast.iter_child_nodes(e):
            expr_steps(child, out, False, role)


def _call_steps(call: ast.Call, out: list[Step], awaited: bool, role: str) -> None:
    name = _last_name(call.func)
    if isinstance(call.func, ast.Attribute):
        expr_steps(call.func.value, out, False, role)
    elif isinstance(call.func, ast.Call):
        expr_steps(call.func, out, False, role)

    args = list(call.args) + [k.value for k in call.keywords]
    if name in DISPATCHERS:
        for a in args:
            if isinstance(a, ast.Starred):
                a = a.value
            if isinstance(a, ast.Call):
                expr_steps(a, out, False, "spawn")
            elif isinstance(a, (ast.Name, ast.Attribute)):
                out.append(RefStep(a))
            else:
                expr_steps(a, out, False, "spawn")
        return

    for a in args:
        expr_steps(a, out, False, role)
    out.append(CallStep(call, awaited, role))


# ── statements ───────────────────────────────────────────────────────────
def body_steps(body: list[ast.stmt]) -> list[Step]:
    out: list[Step] = []
    for st in body:
        _stmt(st, out)
    return out


def _if_arms(node: ast.If) -> list[tuple[str, list[Step]]]:
    arms = [(f"if {_short(ast.unparse(node.test))}", body_steps(node.body))]
    orelse = node.orelse
    if len(orelse) == 1 and isinstance(orelse[0], ast.If):
        nested = orelse[0]
        pre: list[Step] = []
        expr_steps(nested.test, pre)
        tail = _if_arms(nested)
        tail[0] = (tail[0][0].replace("if ", "elif ", 1), pre + tail[0][1])
        return arms + tail
    if orelse:
        arms.append(("else", body_steps(orelse)))
    return arms


def _stmt(st: ast.stmt, out: list[Step]) -> None:
    if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return
    if isinstance(st, ast.If):
        expr_steps(st.test, out)
        out.append(BranchStep("if", st.lineno, _if_arms(st)))
    elif isinstance(st, (ast.For, ast.AsyncFor)):
        expr_steps(st.iter, out)
        prefix = "async for" if isinstance(st, ast.AsyncFor) else "for"
        header = _short(f"{prefix} {ast.unparse(st.target)} in {ast.unparse(st.iter)}")
        out.append(LoopStep("for", header, st.lineno, body_steps(st.body) + body_steps(st.orelse)))
    elif isinstance(st, ast.While):
        inner: list[Step] = []
        expr_steps(st.test, inner)
        inner += body_steps(st.body) + body_steps(st.orelse)
        out.append(LoopStep("while", _short(f"while {ast.unparse(st.test)}"), st.lineno, inner))
    elif isinstance(st, (ast.Try, getattr(ast, "TryStar", ast.Try))):
        arms: list[tuple[str, list[Step]]] = [("try", body_steps(st.body))]
        for h in st.handlers:
            label = f"except {ast.unparse(h.type)}" if h.type is not None else "except"
            arms.append((_short(label), body_steps(h.body)))
        if st.orelse:
            arms.append(("else", body_steps(st.orelse)))
        if st.finalbody:
            arms.append(("finally", body_steps(st.finalbody)))
        out.append(BranchStep("try", st.lineno, arms))
    elif isinstance(st, (ast.With, ast.AsyncWith)):
        for item in st.items:
            expr_steps(item.context_expr, out)
        out.extend(body_steps(st.body))
    elif isinstance(st, ast.Match):
        expr_steps(st.subject, out)
        arms = [(_short(f"case {ast.unparse(c.pattern)}"), body_steps(c.body)) for c in st.cases]
        out.append(BranchStep("match", st.lineno, arms))
    else:
        for child in ast.iter_child_nodes(st):
            expr_steps(child, out)


# ── per-function ─────────────────────────────────────────────────────────
def _depends_call(expr: ast.expr | None) -> ast.expr | None:
    """`Depends(x)` / `Annotated[T, Depends(x)]` -> x."""
    if expr is None:
        return None
    if isinstance(expr, ast.Call) and _last_name(expr.func) in ("Depends", "Security") and expr.args:
        return expr.args[0]
    if isinstance(expr, ast.Subscript) and _last_name(expr.value) == "Annotated":
        elts = expr.slice.elts if isinstance(expr.slice, ast.Tuple) else []
        for el in elts[1:]:
            found = _depends_call(el)
            if found is not None:
                return found
    return None


def function_steps(node: ast.FunctionDef | ast.AsyncFunctionDef) -> list[Step]:
    steps: list[Step] = []
    a = node.args
    pos = a.posonlyargs + a.args
    defaults: list[ast.expr | None] = [None] * (len(pos) - len(a.defaults)) + list(a.defaults)
    for arg, default in list(zip(pos, defaults)) + list(zip(a.kwonlyargs, a.kw_defaults)):
        target = _depends_call(default) or _depends_call(arg.annotation)
        if target is not None:
            steps.append(DependsStep(target, arg.lineno))
    steps.extend(body_steps(node.body))
    return steps

"""backend/analysis/registry.py — every function, method and nested closure
in the project (not only the top-level ones the catalogue scanner lists),
plus classes and module-level variable assignments.

Ids match brain's monitor: "dotted.module:QualName", where nested functions
use Python's qualname ("factory.<locals>._get", "Cls.method").
"""

from __future__ import annotations

import ast
from dataclasses import dataclass, field

from backend.analysis.symbols import FuncNode, ProjectIndex, collect_imports, iter_stmts


@dataclass
class Func:
    id: str
    module: str
    qual: str
    name: str
    node: FuncNode
    file_path: str
    line: int
    end_line: int
    is_async: bool
    class_id: str | None
    parent_id: str | None
    params: list[str]
    param_ann: dict[str, ast.expr | None]
    decorators: list[str]
    is_stub: bool
    is_static: bool
    is_classmethod: bool
    is_package: bool = False
    _locals: tuple[dict[str, ast.expr], dict[str, ast.expr]] | None = field(default=None, repr=False)
    _imports: dict[str, tuple[str, str | None]] | None = field(default=None, repr=False)

    @property
    def signature(self) -> str:
        sig = f"({ast.unparse(self.node.args)})"
        if self.node.returns is not None:
            sig += f" -> {ast.unparse(self.node.returns)}"
        return sig

    @property
    def doc(self) -> str | None:
        d = ast.get_docstring(self.node)
        return d.strip().split("\n")[0][:200] if d else None

    @property
    def imports(self) -> dict[str, tuple[str, str | None]]:
        """Imports done inside the function body (`from x import y`)."""
        if self._imports is None:
            self._imports = collect_imports(self.node.body, self.module, self.is_package)
        return self._imports

    def locals(self) -> tuple[dict[str, ast.expr], dict[str, ast.expr]]:
        """(name -> last assigned value expr, name -> annotation) for the
        function's own scope (nested defs excluded)."""
        if self._locals is None:
            assigns: dict[str, ast.expr] = {}
            anns: dict[str, ast.expr] = {}
            for st in iter_stmts(self.node.body):
                if isinstance(st, ast.Assign):
                    for t in st.targets:
                        if isinstance(t, ast.Name):
                            assigns[t.id] = st.value
                elif isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name):
                    anns[st.target.id] = st.annotation
                    if st.value is not None:
                        assigns[st.target.id] = st.value
                elif isinstance(st, (ast.With, ast.AsyncWith)):
                    for item in st.items:
                        if isinstance(item.optional_vars, ast.Name):
                            assigns[item.optional_vars.id] = item.context_expr
            self._locals = (assigns, anns)
        return self._locals


@dataclass
class Cls:
    id: str
    module: str
    qual: str
    name: str
    node: ast.ClassDef
    bases: list[ast.expr]
    methods: dict[str, str]
    """method name -> Func id (own methods only)."""
    file_path: str
    line: int
    is_protocol: bool = False


def _is_stub(node: FuncNode) -> bool:
    body = node.body
    for st in body:
        if isinstance(st, ast.Pass):
            continue
        if isinstance(st, ast.Expr) and isinstance(st.value, ast.Constant):
            continue  # docstring or Ellipsis
        if isinstance(st, ast.Raise) and isinstance(st.exc, (ast.Name, ast.Call)):
            target = st.exc.func if isinstance(st.exc, ast.Call) else st.exc
            if isinstance(target, ast.Name) and target.id == "NotImplementedError":
                continue
        return False
    return True


class Registry:
    def __init__(self, index: ProjectIndex):
        self.index = index
        self.funcs: dict[str, Func] = {}
        self.classes: dict[str, Cls] = {}
        self.module_assigns: dict[str, dict[str, ast.expr]] = {}
        self.module_ann: dict[str, dict[str, ast.expr]] = {}
        for module in index.modules.values():
            self._module(module.name, module.file_path, module.tree)

    def _module(self, name: str, file_path: str, tree: ast.Module) -> None:
        assigns: dict[str, ast.expr] = {}
        anns: dict[str, ast.expr] = {}
        self.module_assigns[name] = assigns
        self.module_ann[name] = anns
        for st in iter_stmts(tree.body):
            if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._func(st, name, file_path, st.name, None, None)
            elif isinstance(st, ast.ClassDef):
                self._class(st, name, file_path)
            elif isinstance(st, ast.Assign):
                for t in st.targets:
                    if isinstance(t, ast.Name):
                        assigns[t.id] = st.value
            elif isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name):
                anns[st.target.id] = st.annotation
                if st.value is not None:
                    assigns[st.target.id] = st.value

    def _class(self, node: ast.ClassDef, module: str, file_path: str) -> None:
        cid = f"{module}:{node.name}"
        cls = Cls(
            id=cid, module=module, qual=node.name, name=node.name, node=node,
            bases=list(node.bases), methods={}, file_path=file_path, line=node.lineno,
        )
        cls.is_protocol = any(
            (isinstance(b, ast.Name) and b.id == "Protocol") or (isinstance(b, ast.Attribute) and b.attr == "Protocol")
            or (isinstance(b, ast.Subscript) and "Protocol" in ast.unparse(b.value))
            for b in node.bases
        )
        self.classes[cid] = cls
        for st in iter_stmts(node.body):
            if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
                f = self._func(st, module, file_path, f"{node.name}.{st.name}", cid, None)
                cls.methods[st.name] = f.id

    def _func(
        self, node: FuncNode, module: str, file_path: str, qual: str, class_id: str | None, parent_id: str | None
    ) -> Func:
        a = node.args
        every = a.posonlyargs + a.args + a.kwonlyargs
        params = [x.arg for x in every]
        param_ann: dict[str, ast.expr | None] = {x.arg: x.annotation for x in every}
        if a.vararg:
            params.append(a.vararg.arg)
        if a.kwarg:
            params.append(a.kwarg.arg)
        decos = [ast.unparse(d) for d in node.decorator_list]
        fid = f"{module}:{qual}"
        f = Func(
            id=fid, module=module, qual=qual, name=node.name, node=node, file_path=file_path,
            line=node.lineno, end_line=node.end_lineno or node.lineno, is_async=isinstance(node, ast.AsyncFunctionDef),
            class_id=class_id, parent_id=parent_id, params=params, param_ann=param_ann, decorators=decos,
            is_stub=_is_stub(node), is_static="staticmethod" in decos, is_classmethod="classmethod" in decos,
            is_package=self.index.modules[module].is_package,
        )
        self.funcs[fid] = f
        for st in iter_stmts(node.body):
            if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._func(st, module, file_path, f"{qual}.<locals>.{st.name}", None, fid)
        return f

"""backend/analysis/routes.py — static FastAPI route discovery.

Finds every HTTP/WebSocket endpoint of the target project without importing
it. Handles the shapes real projects use:

  * module-level ``router = APIRouter(prefix=..., dependencies=[...])`` with
    ``@router.get("/x")`` decorators
  * ``parent.include_router(child, prefix=...)`` chains, at module level or
    inside an app factory, following imports across modules
  * router *factories* — functions that build an APIRouter, add routes to it
    and ``return`` it (each call site becomes its own router instance, keeping
    the call's keyword arguments as "bindings")
  * routes registered under ``if param is not None:`` inside factories
  * handlers nested in functions (``create_app.<locals>._x``), and an app
    passed in as a parameter (``def setup(app: FastAPI)``)
  * ``add_api_route`` / ``add_api_websocket_route``

Two passes: pass 1 walks every scope (module body / function body) and records
raw declarations; pass 2 resolves names to routers and expands each app's
router tree into concrete endpoints.
"""

from __future__ import annotations

import argparse
import ast
from dataclasses import dataclass, field

from backend.analysis.models import Endpoint, RouteAnalysis, UnmountedRouter
from backend.analysis.symbols import FuncNode, ProjectIndex, collect_imports
from backend.config import DEFAULT_IGNORED_DIRECTORIES, ExplorerConfig

HTTP_METHODS = {"get", "post", "put", "patch", "delete", "head", "options", "trace"}
CONTAINER_CTORS = {"APIRouter": "router", "FastAPI": "app"}


# ── raw declarations (pass 1) ────────────────────────────────────────────
@dataclass
class Cond:
    kind: str  # "notnone" | "other"
    param: str | None = None


@dataclass
class Scope:
    module: str
    qual: str  # "" for module scope, else Python qualname ("f.<locals>.g")
    parent: "Scope | None"
    node: FuncNode | None = None
    imports: dict[str, tuple[str, str | None]] = field(default_factory=dict)
    containers: dict[str, "Container"] = field(default_factory=dict)
    assigns: dict[str, ast.Call] = field(default_factory=dict)
    aliases: dict[str, ast.expr] = field(default_factory=dict)
    consts: dict[str, ast.expr] = field(default_factory=dict)
    instances: dict[str, "Container"] = field(default_factory=dict)
    returns: str | None = None
    params: dict[str, str | None] = field(default_factory=dict)  # name -> annotation


@dataclass
class RouteDecl:
    method: str
    path: ast.expr | None
    kwargs: dict[str, ast.expr]
    scope: Scope
    cond: Cond | None
    conditional: bool
    node: FuncNode | None = None
    handler_expr: ast.expr | None = None
    line: int = 0


@dataclass
class IncludeDecl:
    child: ast.expr
    prefix: ast.expr | None
    dependencies: list[str]
    tags: list[str]
    scope: Scope
    cond: Cond | None
    conditional: bool
    dependency_exprs: list[ast.expr] = field(default_factory=list)


@dataclass
class Container:
    id: str
    kind: str  # router | app | instance
    scope: Scope
    var: str
    line: int
    prefix: ast.expr | None = None
    dependencies: list[str] = field(default_factory=list)
    dependency_exprs: list[ast.expr] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    routes: list[RouteDecl] = field(default_factory=list)
    includes: list[IncludeDecl] = field(default_factory=list)
    template: "Container | None" = None
    factory: str | None = None
    bindings: dict[str, ast.expr] = field(default_factory=dict)
    is_template: bool = False
    param_app: bool = False


def _last_name(expr: ast.expr) -> str | None:
    if isinstance(expr, ast.Name):
        return expr.id
    if isinstance(expr, ast.Attribute):
        return expr.attr
    return None


def _kwargs(call: ast.Call) -> dict[str, ast.expr]:
    return {k.arg: k.value for k in call.keywords if k.arg}


def _depends_targets(expr: ast.expr | None) -> list[str]:
    """`[Depends(a), Depends(b)]` -> ["a", "b"]."""
    out: list[str] = []
    if isinstance(expr, (ast.List, ast.Tuple)):
        for el in expr.elts:
            if isinstance(el, ast.Call) and _last_name(el.func) in ("Depends", "Security") and el.args:
                out.append(ast.unparse(el.args[0]))
    return out


def _depends_exprs(expr: ast.expr | None) -> list[ast.expr]:
    out: list[ast.expr] = []
    if isinstance(expr, (ast.List, ast.Tuple)):
        for el in expr.elts:
            if isinstance(el, ast.Call) and _last_name(el.func) in ("Depends", "Security") and el.args:
                out.append(el.args[0])
    return out


def _str_list(expr: ast.expr | None) -> list[str]:
    if isinstance(expr, (ast.List, ast.Tuple)):
        return [e.value for e in expr.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)]
    return []


def _is_strish(expr: ast.expr) -> bool:
    if isinstance(expr, ast.Constant):
        return isinstance(expr.value, str)
    if isinstance(expr, ast.JoinedStr):
        return True
    return isinstance(expr, ast.BinOp) and isinstance(expr.op, ast.Add) and _is_strish(expr.left)


def _cond_of(test: ast.expr) -> Cond:
    if (
        isinstance(test, ast.Compare)
        and len(test.ops) == 1
        and isinstance(test.ops[0], ast.IsNot)
        and isinstance(test.left, ast.Name)
        and isinstance(test.comparators[0], ast.Constant)
        and test.comparators[0].value is None
    ):
        return Cond("notnone", test.left.id)
    return Cond("other")


class RouteAnalyzer:
    def __init__(self, index: ProjectIndex):
        self.index = index
        self.scopes: dict[tuple[str, str], Scope] = {}
        self.containers: list[Container] = []
        self._pending_routes: list[tuple[Scope, ast.expr, RouteDecl]] = []
        self._pending_includes: list[tuple[Scope, ast.expr, IncludeDecl]] = []
        self.errors: list[str] = []

    # ── pass 1 ───────────────────────────────────────────────────────────
    def collect(self) -> None:
        for module in self.index.modules.values():
            root = Scope(module=module.name, qual="", parent=None, imports=module.imports)
            self.scopes[(module.name, "")] = root
            self._walk(root, module.tree.body, None, False)

    def _child_scope(self, parent: Scope, node: FuncNode) -> Scope:
        qual = f"{parent.qual}.<locals>.{node.name}" if parent.qual else node.name
        scope = Scope(module=parent.module, qual=qual, parent=parent, node=node)
        args = node.args
        for a in args.posonlyargs + args.args + args.kwonlyargs:
            scope.params[a.arg] = ast.unparse(a.annotation) if a.annotation else None
        self.scopes[(scope.module, qual)] = scope
        return scope

    def _walk(self, scope: Scope, body: list[ast.stmt], cond: Cond | None, conditional: bool) -> None:
        for stmt in body:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._decorators(scope, stmt, cond, conditional)
                child = self._child_scope(scope, stmt)
                child.imports = collect_imports(stmt.body, scope.module, self.index.modules[scope.module].is_package)
                self._walk(child, stmt.body, None, False)
            elif isinstance(stmt, ast.ClassDef):
                continue
            elif isinstance(stmt, (ast.Assign, ast.AnnAssign)):
                self._assign(scope, stmt)
            elif isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call):
                self._call_stmt(scope, stmt.value, cond, conditional)
            elif isinstance(stmt, ast.Return):
                if isinstance(stmt.value, ast.Name):
                    scope.returns = stmt.value.id
            elif isinstance(stmt, ast.If):
                self._walk(scope, stmt.body, _cond_of(stmt.test), conditional)
                self._walk(scope, stmt.orelse, None, True)
            else:
                for attr in ("body", "orelse", "finalbody"):
                    inner = getattr(stmt, attr, None)
                    if isinstance(inner, list):
                        self._walk(scope, inner, cond, conditional)
                for handler in getattr(stmt, "handlers", []) or []:
                    self._walk(scope, handler.body, cond, conditional)

    def _assign(self, scope: Scope, stmt: ast.Assign | ast.AnnAssign) -> None:
        targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
        value = stmt.value
        if value is None:
            return
        for target in targets:
            if not isinstance(target, ast.Name):
                continue
            var = target.id
            if isinstance(value, ast.Call) and _last_name(value.func) in CONTAINER_CTORS:
                kw = _kwargs(value)
                c = Container(
                    id=f"{scope.module}:{scope.qual + '|' if scope.qual else ''}{var}",
                    kind=CONTAINER_CTORS[_last_name(value.func)],  # type: ignore[index]
                    scope=scope,
                    var=var,
                    line=stmt.lineno,
                    prefix=kw.get("prefix"),
                    dependencies=_depends_targets(kw.get("dependencies")),
                    dependency_exprs=_depends_exprs(kw.get("dependencies")),
                    tags=_str_list(kw.get("tags")),
                )
                scope.containers[var] = c
                self.containers.append(c)
            elif isinstance(value, ast.Call):
                scope.assigns[var] = value
            elif isinstance(value, (ast.Name, ast.Attribute)):
                scope.aliases[var] = value
            elif _is_strish(value):
                scope.consts[var] = value

    def _decorators(self, scope: Scope, node: FuncNode, cond: Cond | None, conditional: bool) -> None:
        for dec in node.decorator_list:
            if not (isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute)):
                continue
            attr = dec.func.attr
            kw = _kwargs(dec)
            path = dec.args[0] if dec.args else kw.get("path")
            if attr in HTTP_METHODS:
                methods = [attr.upper()]
            elif attr == "websocket":
                methods = ["WS"]
            elif attr == "api_route":
                methods = [m.upper() for m in _str_list(kw.get("methods"))] or ["GET"]
            else:
                continue
            for method in methods:
                decl = RouteDecl(
                    method=method, path=path, kwargs=kw, scope=scope, cond=cond,
                    conditional=conditional, node=node, line=node.lineno,
                )
                self._pending_routes.append((scope, dec.func.value, decl))

    def _call_stmt(self, scope: Scope, call: ast.Call, cond: Cond | None, conditional: bool) -> None:
        if not isinstance(call.func, ast.Attribute):
            return
        target, attr = call.func.value, call.func.attr
        kw = _kwargs(call)
        if attr == "include_router" and call.args:
            decl = IncludeDecl(
                child=call.args[0], prefix=kw.get("prefix"),
                dependencies=_depends_targets(kw.get("dependencies")), tags=_str_list(kw.get("tags")),
                scope=scope, cond=cond, conditional=conditional,
                dependency_exprs=_depends_exprs(kw.get("dependencies")),
            )
            self._pending_includes.append((scope, target, decl))
        elif attr in ("add_api_route", "add_api_websocket_route") and len(call.args) >= 1:
            handler = call.args[1] if len(call.args) > 1 else kw.get("endpoint")
            methods = ["WS"] if attr == "add_api_websocket_route" else (
                [m.upper() for m in _str_list(kw.get("methods"))] or ["GET"]
            )
            for method in methods:
                decl = RouteDecl(
                    method=method, path=call.args[0], kwargs=kw, scope=scope, cond=cond,
                    conditional=conditional, handler_expr=handler, line=call.lineno,
                )
                self._pending_routes.append((scope, target, decl))

    # ── name resolution (pass 2) ─────────────────────────────────────────
    def _chain(self, scope: Scope):
        s: Scope | None = scope
        while s is not None:
            yield s
            s = s.parent

    def _module_root(self, module: str) -> Scope | None:
        return self.scopes.get((module, ""))

    def lookup_container(self, scope: Scope, expr: ast.expr, depth: int = 0) -> Container | None:
        if depth > 8:
            return None
        if isinstance(expr, ast.Call):
            return self._instance_from_call(scope, expr, f"<call@{expr.lineno}:{expr.col_offset}>")
        if isinstance(expr, ast.Name):
            return self._lookup_name(scope, expr.id, depth)
        if isinstance(expr, ast.Attribute) and isinstance(expr.value, ast.Name):
            mod = self._resolve_module(scope, expr.value.id)
            if mod is not None:
                root = self._module_root(mod)
                if root is not None:
                    return self._container_in(root, expr.attr, depth)
        return None

    def _lookup_name(self, scope: Scope, name: str, depth: int) -> Container | None:
        for s in self._chain(scope):
            found = self._container_in(s, name, depth)
            if found is not None:
                return found
            if name in s.imports:
                mod, attr = s.imports[name]
                res = self.index.resolve_import(mod, attr)
                if res and res[1] is not None:
                    root = self._module_root(res[0])
                    if root is not None:
                        return self._container_in(root, res[1], depth)
                return None
            if name in s.params and s.node is not None:
                ann = s.params[name] or ""
                if "FastAPI" in ann or name == "app":
                    return self._param_app(s, name)
        return None

    def _container_in(self, s: Scope, name: str, depth: int) -> Container | None:
        if name in s.containers:
            return s.containers[name]
        if name in s.aliases:
            return self.lookup_container(s, s.aliases[name], depth + 1)
        if name in s.assigns:
            return self._instance(s, name)
        return None

    def _param_app(self, s: Scope, name: str) -> Container:
        key = f"__param__{name}"
        if key not in s.containers:
            c = Container(
                id=f"{s.module}:{s.qual}|{name}", kind="app", scope=s, var=name,
                line=s.node.lineno if s.node else 0, param_app=True,
            )
            s.containers[key] = c
            self.containers.append(c)
        return s.containers[key]

    def _resolve_module(self, scope: Scope, name: str) -> str | None:
        for s in self._chain(scope):
            if name in s.imports:
                mod, attr = s.imports[name]
                res = self.index.resolve_import(mod, attr)
                if res and res[1] is None:
                    return res[0]
                return None
        return None

    def resolve_callable(self, scope: Scope, expr: ast.expr) -> tuple[str, str] | None:
        """Name/attr expr -> (module, top-level function name) if it is one."""
        if isinstance(expr, ast.Name):
            for s in self._chain(scope):
                if expr.id in s.imports:
                    mod, attr = s.imports[expr.id]
                    res = self.index.resolve_import(mod, attr)
                    break
                if s.parent is None and expr.id in self.index.modules[s.module].top_names:
                    res = (s.module, expr.id)
                    break
            else:
                return None
            if res and res[1] is not None and res[1] in self.index.modules[res[0]].funcs:
                return res  # type: ignore[return-value]
            return None
        if isinstance(expr, ast.Attribute) and isinstance(expr.value, ast.Name):
            mod = self._resolve_module(scope, expr.value.id)
            if mod is not None:
                res = self.index.resolve_import(mod, expr.attr)
                if res and res[1] is not None and res[1] in self.index.modules[res[0]].funcs:
                    return res  # type: ignore[return-value]
        return None

    def _instance(self, scope: Scope, var: str) -> Container | None:
        if var in scope.instances:
            return scope.instances[var]
        return self._instance_from_call(scope, scope.assigns[var], var)

    def _instance_from_call(self, scope: Scope, call: ast.Call, var: str) -> Container | None:
        """A call to a router factory -> a router instance (own routes/includes
        on top of the template's, own bindings). `var` names it (or is
        `<call@line>` for an inline call like `include_router(build(...))`)."""
        if var in scope.instances:
            return scope.instances[var]
        target = self.resolve_callable(scope, call.func)
        if target is None:
            return None
        fscope = self.scopes.get((target[0], target[1]))
        if fscope is None or fscope.returns is None or fscope.returns not in fscope.containers:
            return None
        template = fscope.containers[fscope.returns]
        template.is_template = True
        node = self.index.modules[target[0]].funcs[target[1]]
        bindings: dict[str, ast.expr] = {}
        names = [a.arg for a in node.args.posonlyargs + node.args.args]
        for name, arg in zip(names, call.args):
            bindings[name] = arg
        bindings.update(_kwargs(call))
        inst = Container(
            id=f"{scope.module}:{scope.qual + '|' if scope.qual else ''}{var}",
            kind="instance", scope=scope, var=var, line=call.lineno,
            template=template, factory=f"{target[0]}:{target[1]}", bindings=bindings,
        )
        scope.instances[var] = inst
        self.containers.append(inst)
        return inst

    # ── attach decls (pass 2) ────────────────────────────────────────────
    def attach(self) -> None:
        for scope, target, decl in self._pending_routes:
            c = self.lookup_container(scope, target)
            if c is not None:
                c.routes.append(decl)
        for scope, target, decl in self._pending_includes:
            c = self.lookup_container(scope, target)
            if c is not None:
                c.includes.append(decl)

    # ── string evaluation ────────────────────────────────────────────────
    def eval_str(self, expr: ast.expr | None, scope: Scope, bindings: dict[str, ast.expr], depth: int = 0) -> str:
        if expr is None:
            return ""
        if depth > 6:
            return "{?}"
        if isinstance(expr, ast.Constant) and isinstance(expr.value, str):
            return expr.value
        if isinstance(expr, ast.JoinedStr):
            out = ""
            for v in expr.values:
                if isinstance(v, ast.Constant):
                    out += str(v.value)
                elif isinstance(v, ast.FormattedValue):
                    out += self.eval_str(v.value, scope, bindings, depth + 1)
            return out
        if isinstance(expr, ast.BinOp) and isinstance(expr.op, ast.Add):
            return self.eval_str(expr.left, scope, bindings, depth + 1) + self.eval_str(expr.right, scope, bindings, depth + 1)
        if isinstance(expr, ast.Name):
            if expr.id in bindings:
                return self.eval_str(bindings[expr.id], scope, {}, depth + 1)
            for s in self._chain(scope):
                if expr.id in s.consts:
                    return self.eval_str(s.consts[expr.id], s, {}, depth + 1)
                if expr.id in s.imports:
                    res = self.index.resolve_import(*s.imports[expr.id])
                    root = self._module_root(res[0]) if res and res[1] else None
                    if root is not None and res[1] in root.consts:  # type: ignore[index]
                        return self.eval_str(root.consts[res[1]], root, {}, depth + 1)  # type: ignore[index]
                    break
            return "{" + expr.id + "}"
        return "{" + ast.unparse(expr) + "}"

    # ── expansion ────────────────────────────────────────────────────────
    def expand(self) -> RouteAnalysis:
        endpoints: list[Endpoint] = []
        visited: set[str] = set()
        roots = [c for c in self.containers if c.kind == "app"]
        for root in roots:
            self._expand(root, "", [], [], [root.id], root.param_app, endpoints, visited, set())

        seen: dict[str, int] = {}
        for ep in endpoints:
            base = f"{ep.method} {ep.path}"
            n = seen.get(base, 0)
            seen[base] = n + 1
            ep.id = base if n == 0 else f"{base}#{n + 1}"

        unmounted = [
            UnmountedRouter(
                id=c.id, file_path=self.index.modules[c.scope.module].file_path, line=c.line,
                route_count=len((c.template or c).routes),
            )
            for c in self.containers
            if c.kind != "app" and c.id not in visited and not c.is_template and (c.template or c).routes
        ]
        endpoints.sort(key=lambda e: (e.path, e.method))
        return RouteAnalysis(
            project_path=self.index.root,
            module_count=len(self.index.modules),
            endpoints=endpoints,
            unmounted=unmounted,
            errors=self.index.errors + self.errors,
        )

    def _cond_ok(self, cond: Cond | None, container: Container) -> tuple[bool, bool]:
        """-> (include, still_conditional)"""
        if cond is None:
            return True, False
        if cond.kind == "notnone" and container.kind == "instance":
            expr = container.bindings.get(cond.param or "")
            if expr is None or (isinstance(expr, ast.Constant) and expr.value is None):
                return False, False
            return True, False
        return True, True

    def _expand(
        self, c: Container, prefix: str, deps: list[tuple[str, str | None]], tags: list[str], chain: list[str],
        param_app: bool, out: list[Endpoint], visited: set[str], stack: set[str],
    ) -> None:
        if c.id in stack:
            return
        stack = stack | {c.id}
        visited.add(c.id)
        src = c.template or c
        visited.add(src.id)
        bindings = c.bindings
        own_prefix = self.eval_str(src.prefix, src.scope, bindings)
        base = prefix + own_prefix
        deps = deps + self._dep_pairs(src.scope, src.dependency_exprs)
        tags = tags + src.tags

        # an instance carries the template's routes plus whatever was added
        # to it afterwards (e.g. `router.include_router(_debug)`)
        routes = src.routes + (c.routes if c is not src else [])
        includes = src.includes + (c.includes if c is not src else [])

        for r in routes:
            include, still = self._cond_ok(r.cond, c)
            if not include:
                continue
            out.append(self._endpoint(r, c, src, base, deps, tags, chain, bool(still or r.conditional), param_app))

        for inc in includes:
            include, _ = self._cond_ok(inc.cond, c)
            if not include:
                continue
            child = self.lookup_container(inc.scope, inc.child)
            if child is None:
                self.errors.append(f"unresolved include_router({ast.unparse(inc.child)}) in {inc.scope.module}")
                continue
            self._expand(
                child, base + self.eval_str(inc.prefix, inc.scope, bindings), deps + self._dep_pairs(inc.scope, inc.dependency_exprs),
                tags + inc.tags, chain + [child.id], param_app, out, visited, stack,
            )

    def _dep_pairs(self, scope: Scope, exprs: list[ast.expr]) -> list[tuple[str, str | None]]:
        out: list[tuple[str, str | None]] = []
        for e in exprs:
            target = self.resolve_callable(scope, e)
            out.append((ast.unparse(e), f"{target[0]}:{target[1]}" if target else None))
        return out

    def _endpoint(
        self, r: RouteDecl, c: Container, src: Container, base: str, deps: list[tuple[str, str | None]],
        tags: list[str], chain: list[str], conditional: bool, param_app: bool,
    ) -> Endpoint:
        bindings = c.bindings
        path = base + self.eval_str(r.path, r.scope, bindings)
        if not path.startswith("/"):
            path = "/" + path
        node = r.node
        module = r.scope.module
        if node is None and r.handler_expr is not None:
            target = self.resolve_callable(r.scope, r.handler_expr)
            if target is not None:
                module = target[0]
                node = self.index.modules[target[0]].funcs[target[1]]
                qual = target[1]
            else:
                qual = ast.unparse(r.handler_expr)
        elif node is not None:
            qual = f"{r.scope.qual}.<locals>.{node.name}" if r.scope.qual else node.name
        else:
            qual = "?"
        mod = self.index.modules[module]
        handler_deps: list[str] = []
        sig = "()"
        if node is not None:
            sig = f"({ast.unparse(node.args)})" + (f" -> {ast.unparse(node.returns)}" if node.returns else "")
            for default in node.args.defaults + [d for d in node.args.kw_defaults if d is not None]:
                if isinstance(default, ast.Call) and _last_name(default.func) in ("Depends", "Security") and default.args:
                    handler_deps.append(ast.unparse(default.args[0]))
        kw = r.kwargs
        all_deps = deps + self._dep_pairs(r.scope, _depends_exprs(kw.get("dependencies")))
        bound: dict[str, str | None] = {}
        for name, expr in bindings.items():
            target = self.resolve_callable(c.scope, expr)
            if target is not None:
                bound[name] = f"{target[0]}:{target[1]}"
        return Endpoint(
            id="", method=r.method, path=path, handler_id=f"{module}:{qual}",
            handler_name=node.name if node is not None else qual,
            file_path=mod.file_path, line=node.lineno if node is not None else r.line, signature=sig,
            is_async=isinstance(node, ast.AsyncFunctionDef),
            docstring=ast.get_docstring(node) if node is not None else None,
            summary=self.eval_str(kw["summary"], r.scope, bindings) if "summary" in kw else None,
            response_model=ast.unparse(kw["response_model"]) if "response_model" in kw else None,
            status_code=ast.unparse(kw["status_code"]) if "status_code" in kw else None,
            tags=list(dict.fromkeys(tags + _str_list(kw.get("tags")))),
            dependencies=list(dict.fromkeys(
                [t for t, _ in all_deps] + handler_deps
            )),
            dependency_ids=list(dict.fromkeys(i for _, i in all_deps if i)),
            mount_chain=chain, factory=c.factory, bindings=bound,
            conditional=conditional, param_app=param_app,
        )


def discover_routes(project_path: str, extra_ignored: frozenset[str] = frozenset()) -> RouteAnalysis:
    config = ExplorerConfig(
        project_path=project_path,
        ignored_directories=frozenset(DEFAULT_IGNORED_DIRECTORIES | set(extra_ignored)),
    )
    analyzer = RouteAnalyzer(ProjectIndex(config))
    analyzer.collect()
    analyzer.attach()
    return analyzer.expand()


def main() -> None:
    parser = argparse.ArgumentParser(description="Print every endpoint discovered in a FastAPI project.")
    parser.add_argument("--project", required=True)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    result = discover_routes(args.project)
    if args.json:
        print(result.model_dump_json(indent=2))
        return
    for ep in result.endpoints:
        flags = ("  [cond]" if ep.conditional else "") + ("  [param-app]" if ep.param_app else "")
        print(f"{ep.method:6} {ep.path:60} -> {ep.handler_id}{flags}")
    print(f"\n{len(result.endpoints)} endpoints, {len(result.unmounted)} unmounted routers, "
          f"{result.module_count} modules, {len(result.errors)} errors")
    for u in result.unmounted:
        print(f"  unmounted: {u.id} ({u.route_count} routes) {u.file_path}:{u.line}")
    for e in result.errors:
        print(f"  error: {e}")


if __name__ == "__main__":
    main()

"""backend/analysis/symbols.py — a whole-project symbol index built with the
stdlib `ast` (no imports of the target code): every module's tree, its
import aliases and its top-level names, plus cross-module name resolution
that follows `from x import y as z` / re-export chains.
"""

from __future__ import annotations

import ast
import os
from dataclasses import dataclass, field

from backend.config import ExplorerConfig
from backend.scanner.project_scanner import _module_name

FuncNode = ast.FunctionDef | ast.AsyncFunctionDef

# top-level dirs that are never the target's business code
NON_SOURCE_ROOTS = {"tests", "test", "conftest", "scripts", "migrations", "alembic", "docs"}


@dataclass
class Module:
    name: str
    file_path: str
    is_package: bool
    tree: ast.Module
    imports: dict[str, tuple[str, str | None]] = field(default_factory=dict)
    """local name -> (module, attr). attr None means the name is the module."""
    top_names: set[str] = field(default_factory=set)
    funcs: dict[str, FuncNode] = field(default_factory=dict)


def iter_stmts(body: list[ast.stmt]):
    """Statements of one scope, descending compound statements but never
    into nested function/class bodies (those are their own scopes)."""
    for stmt in body:
        yield stmt
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        for attr in ("body", "orelse", "finalbody"):
            inner = getattr(stmt, attr, None)
            if isinstance(inner, list):
                yield from iter_stmts(inner)
        for handler in getattr(stmt, "handlers", []) or []:
            yield from iter_stmts(handler.body)


def collect_imports(body: list[ast.stmt], module: str, is_package: bool) -> dict[str, tuple[str, str | None]]:
    out: dict[str, tuple[str, str | None]] = {}
    for stmt in iter_stmts(body):
        if isinstance(stmt, ast.Import):
            for alias in stmt.names:
                if alias.asname:
                    out[alias.asname] = (alias.name, None)
                else:
                    head = alias.name.split(".", 1)[0]
                    out[head] = (head, None)
        elif isinstance(stmt, ast.ImportFrom):
            base = _absolute_from(stmt, module, is_package)
            if base is None:
                continue
            for alias in stmt.names:
                if alias.name == "*":
                    continue
                out[alias.asname or alias.name] = (base, alias.name)
    return out


def _absolute_from(stmt: ast.ImportFrom, module: str, is_package: bool) -> str | None:
    if stmt.level == 0:
        return stmt.module
    pkg = module.split(".") if is_package else module.split(".")[:-1]
    drop = stmt.level - 1
    if drop > len(pkg):
        return None
    pkg = pkg[: len(pkg) - drop] if drop else pkg
    if stmt.module:
        pkg = pkg + stmt.module.split(".")
    return ".".join(pkg)


class ProjectIndex:
    def __init__(self, config: ExplorerConfig):
        self.root = os.path.abspath(config.project_path)
        self.modules: dict[str, Module] = {}
        self.errors: list[str] = []
        self._load(config)

    def _load(self, config: ExplorerConfig) -> None:
        for dirpath, dirs, files in os.walk(self.root):
            dirs[:] = [d for d in dirs if not config.should_ignore_dir(d)]
            for filename in files:
                if not filename.endswith(".py"):
                    continue
                absolute = os.path.join(dirpath, filename)
                rel = os.path.relpath(absolute, self.root)
                name = _module_name(rel)
                if name.split(".", 1)[0] in NON_SOURCE_ROOTS:
                    continue
                try:
                    with open(absolute, "r", encoding="utf-8") as f:
                        tree = ast.parse(f.read(), filename=rel)
                except (OSError, SyntaxError) as exc:
                    self.errors.append(f"{rel}: {exc.__class__.__name__}: {exc}")
                    continue
                mod = Module(name=name, file_path=rel, is_package=filename == "__init__.py", tree=tree)
                mod.imports = collect_imports(tree.body, name, mod.is_package)
                for stmt in iter_stmts(tree.body):
                    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        mod.top_names.add(stmt.name)
                        mod.funcs[stmt.name] = stmt
                    elif isinstance(stmt, ast.ClassDef):
                        mod.top_names.add(stmt.name)
                    elif isinstance(stmt, ast.Assign):
                        for t in stmt.targets:
                            if isinstance(t, ast.Name):
                                mod.top_names.add(t.id)
                    elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                        mod.top_names.add(stmt.target.id)
                self.modules[name] = mod

    def resolve_import(self, module: str, attr: str | None, depth: int = 0) -> tuple[str, str | None] | None:
        """Where does `from <module> import <attr>` really land?
        Returns ("module", None) semantics as (module_name, None) for a
        module, or (module_name, name) for a name defined in that module."""
        if depth > 8 or module not in self.modules:
            return None
        if attr is None:
            return (module, None)
        target = self.modules[module]
        if attr in target.top_names and attr not in target.imports:
            return (module, attr)
        if attr in target.imports:
            nxt_mod, nxt_attr = target.imports[attr]
            return self.resolve_import(nxt_mod, nxt_attr, depth + 1)
        sub = f"{module}.{attr}"
        if sub in self.modules:
            return (sub, None)
        return None

    def resolve_module_name(self, module: str, name: str) -> tuple[str, str | None] | None:
        """Resolve a bare `name` used at module scope of `module`."""
        mod = self.modules.get(module)
        if mod is None:
            return None
        if name in mod.imports:
            imp_mod, imp_attr = mod.imports[name]
            return self.resolve_import(imp_mod, imp_attr)
        if name in mod.top_names:
            return (module, name)
        return None

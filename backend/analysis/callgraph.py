"""backend/analysis/callgraph.py — endpoint -> inner-function hierarchy.

Static and context-sensitive: a function's calls are resolved against the
"bindings" its caller passed (a callable / class instance bound to a
parameter), so a generic router factory or a Protocol-typed ``adapter``
parameter resolves to the concrete functions of *this* endpoint.

What it understands
  * calls to module functions, imported functions, methods (``self.x()``,
    ``obj.x()`` via constructor / annotation / return-annotation typing,
    ``super()``), classmethods, class constructors (-> ``__init__``)
  * nested closures and closure variables (factory params)
  * Protocol / ABC dispatch -> the concrete implementations
  * callables passed as arguments (callbacks) and to create_task/gather/...
  * FastAPI ``Depends`` (router-level, route-level, parameter-level)
  * LangGraph ``StateGraph`` builders: ``compiled.astream(...)`` expands the
    graph's nodes/edges/routers
  * loops / branches / try blocks as marker nodes (see flow.py)

What it cannot resolve becomes an "unresolved" node (never silently
dropped), except obvious noise (builtins, logging, str/dict/list methods).
"""

from __future__ import annotations

import ast
import builtins
import itertools
import re
from dataclasses import dataclass, field
from typing import Any

from backend.analysis.cypher import UNKNOWN, extract, looks_like_cypher
from backend.analysis.flow import (
    BranchStep, CallStep, DependsStep, LoopStep, RefStep, Step, function_steps,
)
from backend.analysis.models import Endpoint
from backend.analysis.registry import Func, Registry
from backend.analysis.symbols import ProjectIndex, iter_stmts

MAX_DEPTH = 80
GRAPH_CTORS = {"StateGraph", "MessageGraph", "Graph"}
GRAPH_RUN = {"invoke", "ainvoke", "stream", "astream", "astream_events", "batch", "abatch"}
BUILTIN_NAMES = set(dir(builtins))
NOISE_ATTRS = {
    # str / bytes
    "join", "split", "rsplit", "strip", "lstrip", "rstrip", "format", "lower", "upper", "startswith",
    "endswith", "replace", "encode", "decode", "title", "capitalize", "splitlines", "partition", "casefold",
    # list / dict / set
    "append", "extend", "insert", "pop", "remove", "clear", "copy", "get", "items", "keys", "values",
    "update", "setdefault", "add", "discard", "sort", "reverse", "index", "count", "union", "intersection",
    "difference", "popitem", "fromkeys",
    "isupper", "islower", "isdigit", "isalpha", "isalnum", "isspace", "find", "rfind", "zfill", "ljust", "rjust",
    "center", "swapcase", "removeprefix", "removesuffix", "isnumeric", "isidentifier", "translate", "expandtabs",
    # logging
    "debug", "info", "warning", "warn", "error", "exception", "critical", "log",
    # pydantic / misc data helpers
    "model_dump", "model_dump_json", "model_validate", "model_copy", "dict", "json",
    # re.Match / re.Pattern
    "group", "groups", "groupdict", "match", "search", "fullmatch", "findall", "finditer", "sub", "subn",
}
# ── database access ─────────────────────────────────────────────────────
# Motor collection methods -> operation
MONGO_OPS = {
    "find": "read", "find_one": "read", "count_documents": "read", "estimated_document_count": "read",
    "aggregate": "read", "distinct": "read",
    "insert_one": "write", "insert_many": "write", "update_one": "write", "update_many": "write",
    "replace_one": "write", "find_one_and_update": "write", "find_one_and_replace": "write", "bulk_write": "write",
    "delete_one": "delete", "delete_many": "delete", "find_one_and_delete": "delete", "drop": "delete",
}
# Beanie Document classmethods / instance methods -> operation
BEANIE_OPS = {
    "find": "read", "find_one": "read", "find_all": "read", "get": "read", "count": "read", "aggregate": "read", "all": "read",
    "insert": "write", "insert_one": "write", "insert_many": "write", "save": "write", "replace": "write",
    "update": "write", "set": "write", "upsert": "upsert", "create": "write",
    "delete": "delete", "delete_one": "delete", "delete_many": "delete", "delete_all": "delete",
}
# Beanie calls whose result is (an instance of) the document itself
BEANIE_RETURNS_DOC = {"find_one", "get", "create", "insert", "save", "replace", "upsert"}
# cursor / chaining helpers that follow a collection call and are not interesting
NOISE_ATTRS |= {"to_list", "sort", "limit", "skip", "batch_size", "hint", "allow_disk_use", "next", "close", "max_time_ms"}
# Database calls on an object whose type we could not determine. They are not
# guessed into a table — they are flagged so the coverage audit can list them.
UNTYPED_DB_ATTRS = {
    "run", "execute_read", "execute_write",  # neo4j session / transaction
    "find_one", "insert_one", "insert_many", "update_one", "update_many", "replace_one",
    "delete_one", "delete_many", "bulk_write", "aggregate", "count_documents",  # motor collection
}
NEO4J_RUN_ATTRS = {"run", "execute_read", "execute_write"}
# Where a Motor call's document / filter / update sits, for field inference
MONGO_DOC_ARG = {"insert_one": 0, "insert_many": 0, "replace_one": 1, "find_one_and_replace": 1}
MONGO_FILTER_ARG = {
    "find": 0, "find_one": 0, "count_documents": 0, "delete_one": 0, "delete_many": 0, "find_one_and_delete": 0,
    "update_one": 0, "update_many": 0, "replace_one": 0, "find_one_and_update": 0, "find_one_and_replace": 0,
}
MONGO_UPDATE_ARG = {"update_one": 1, "update_many": 1, "find_one_and_update": 1}
UPDATE_OPERATORS = {"$set", "$setOnInsert", "$inc", "$push", "$addToSet", "$unset", "$min", "$max", "$mul", "$pull"}
MODEL_DUMPS = {"model_dump", "dict"}
_PY_TYPES = {str: "string", int: "integer", float: "number", bool: "boolean", type(None): "null"}
# a function taking the query as a parameter is a generic executor: the queries
# (and so the tables) belong to whoever builds and passes them
QUERY_PARAMS = {"query", "cypher", "statement", "stmt", "q", "cql"}
MAX_TEMPLATES = 24

NOISE_EXT_ROOTS = ("logging", "builtins", "typing", "dataclasses", "abc", "enum", "collections.abc")


@dataclass(frozen=True)
class V:
    """An abstract value: what a name / expression refers to."""
    kind: str  # func | class | inst | graph | module | ext | param | dispatch | super
    ref: str
    extra: tuple = ()


Env = dict[tuple[str, str], V]


@dataclass
class N:
    kind: str  # function | external | unresolved | class | loop | branch | arm | graph | dispatch
    name: str
    function_id: str | None = None
    file_path: str | None = None
    line: int | None = None
    signature: str | None = None
    is_async: bool = False
    doc: str | None = None
    edge: str = "call"  # call | await | spawn | callback | depends | graph_node | router | instantiate
    call_line: int | None = None
    call_expr: str | None = None
    label: str | None = None
    external: str | None = None
    cyclic: bool = False
    meta: dict[str, Any] = field(default_factory=dict)
    children: list["N"] = field(default_factory=list)


@dataclass
class GraphDef:
    builder: str
    nodes: dict[str, ast.expr]
    edges: list[tuple[str, str]]
    cond: list[tuple[str, ast.expr, dict[str, str]]]
    entry: str | None


_NEO4J_NODE_SCHEMA = re.compile(
    r"CREATE\s+(?:(?:RANGE|TEXT|POINT|FULLTEXT|LOOKUP)\s+)?(INDEX|CONSTRAINT)\s+(\w+)?\s*(?:IF\s+NOT\s+EXISTS\s+)?"
    r"FOR\s*\(\s*\w*\s*:\s*`?(\w+)`?\s*\)\s*(?:ON|REQUIRE)\s*\(?([^)]*?)\)?\s*(IS\s+UNIQUE|IS\s+NOT\s+NULL|IS\s+NODE\s+KEY)?\s*$",
    re.I,
)
_NEO4J_REL_SCHEMA = re.compile(
    r"CREATE\s+(?:\w+\s+)?(INDEX|CONSTRAINT)\s+(\w+)?\s*(?:IF\s+NOT\s+EXISTS\s+)?"
    r"FOR\s*\(\)\s*-\s*\[\s*\w*\s*:\s*`?(\w+)`?\s*\]\s*-\s*\(\)\s*(?:ON|REQUIRE)\s*\(?([^)]*?)\)?\s*(IS\s+UNIQUE|IS\s+NOT\s+NULL)?\s*$",
    re.I,
)


def parse_neo4j_schema_statement(text: str) -> list[tuple[str, list[str], bool, str, str | None]]:
    """`CREATE CONSTRAINT k IF NOT EXISTS FOR (n:KNode) REQUIRE n.node_id IS UNIQUE` ->
    [("neo4j:KNode", ["node_id"], True, "constraint", "k")]."""
    out = []
    for stmt in text.split(";"):
        stmt = " ".join(stmt.replace(UNKNOWN, "_UNK_").split())
        for rx, prefix in ((_NEO4J_NODE_SCHEMA, "neo4j"), (_NEO4J_REL_SCHEMA, "neo4j-rel")):
            m = rx.search(stmt)
            if not m:
                continue
            kind, name, label, props, tail = (m.group(i) for i in (1, 2, 3, 4, 5))
            if "_UNK_" in label or "_UNK_" in props:
                break  # the label or a property could not be resolved: not a table we can name
            if name and "_UNK_" in name:
                name = None
            keys = [p.split(".")[-1].strip().strip("`") for p in props.replace("(", "").split(",") if p.strip()]
            unique = bool(tail and ("UNIQUE" in tail.upper() or "NODE KEY" in tail.upper()))
            out.append((f"{prefix}:{label}", keys, unique, kind.lower(), name))
            break
    return out


def _short(text: str, n: int = 110) -> str:
    text = " ".join(text.split())
    return text if len(text) <= n else text[: n - 1] + "…"


def _last_name(expr: ast.expr) -> str | None:
    if isinstance(expr, ast.Name):
        return expr.id
    if isinstance(expr, ast.Attribute):
        return expr.attr
    return None


def _env_key(env: Env) -> tuple:
    return tuple(sorted(env.items(), key=lambda kv: kv[0]))


class CallGraph:
    def __init__(self, index: ProjectIndex, registry: Registry):
        self.index = index
        self.reg = registry
        self._steps: dict[str, list[Step]] = {}
        self._memo: dict[tuple, tuple[list[N], frozenset[str]]] = {}
        self._defined: dict[tuple[str, str], V | None] = {}
        self._defining: set[tuple[str, str]] = set()
        self._ann: dict[tuple[str, str], V | None] = {}
        self._attr_types: dict[str, dict[str, V]] = {}
        self._graph_defs: dict[str, GraphDef | None] = {}
        self._impls: dict[tuple[str, str], list[str]] = {}
        self._subclass_cache: dict[str, set[str]] | None = None
        self._factories: dict[str, list[tuple[str, int | None]] | None] = {}
        self._returned: dict[str, str | None] = {}
        self._returned_inst: dict[str, V | None] = {}
        self._beanie: dict[str, str | None] = {}
        self._cypher: dict[str, list[tuple[str, str]]] = {}
        self._class_fields: dict[str, list[tuple[str, str]]] = {}

    # ── value evaluation ─────────────────────────────────────────────────
    def eval_expr(self, module: str, F: Func | None, expr: ast.AST | None, env: Env, depth: int = 0) -> V | None:
        if depth > 12 or expr is None:
            return None
        if isinstance(expr, ast.Await):
            return self.eval_expr(module, F, expr.value, env, depth + 1)
        if isinstance(expr, ast.Constant) and isinstance(expr.value, str):
            return V("str", expr.value)
        if isinstance(expr, ast.Name):
            return self.eval_name(module, F, expr.id, env, depth)
        if isinstance(expr, ast.Attribute):
            if isinstance(expr.value, ast.Call) and _last_name(expr.value.func) == "super":
                return self._member(V("super", F.class_id or ""), expr.attr) if F and F.class_id else None
            base = self.eval_expr(module, F, expr.value, env, depth + 1)
            return self._member(base, expr.attr) if base else None
        if isinstance(expr, ast.Call):
            return self._call_value(module, F, expr, env, depth)
        return None

    def eval_name(self, module: str, F: Func | None, name: str, env: Env, depth: int) -> V | None:
        f = F
        while f is not None:
            nested = f"{f.module}:{f.qual}.<locals>.{name}"
            if nested in self.reg.funcs:
                return V("func", nested)
            if name in f.imports and name not in f.params:
                return self._eval_import(f.imports[name])
            if name in f.params:
                bound = env.get((f.id, name))
                if bound is not None:
                    return bound
                if name in ("self", "cls") and f.class_id:
                    return V("inst" if name == "self" else "class", f.class_id)
                t = self.type_from_ann(f.module, f.param_ann.get(name))
                return t if t is not None else V("param", f"{f.id}|{name}")
            assigns, anns = f.locals()
            if name in assigns or name in anns:
                v = self.eval_expr(f.module, f, assigns.get(name), env, depth + 1)
                if v is None and name in anns:
                    v = self.type_from_ann(f.module, anns[name])
                return v
            f = self.reg.funcs.get(f.parent_id) if f.parent_id else None
        return self._eval_module_name(module, name, depth)

    def _eval_module_name(self, module: str, name: str, depth: int) -> V | None:
        mod = self.index.modules.get(module)
        if mod is None:
            return None
        if name in mod.imports:
            return self._eval_import(mod.imports[name], depth)
        if name in mod.top_names:
            return self._eval_defined(module, name, depth)
        return None

    def _eval_import(self, imp: tuple[str, str | None], depth: int = 0) -> V | None:
        imod, iattr = imp
        res = self.index.resolve_import(imod, iattr)
        if res is not None:
            return V("module", res[0]) if res[1] is None else self._eval_defined(res[0], res[1], depth)
        return V("ext", f"{imod}.{iattr}" if iattr else imod)

    def _eval_defined(self, module: str, name: str, depth: int) -> V | None:
        key = (module, name)
        if key in self._defined:
            return self._defined[key]
        fid = f"{module}:{name}"
        if fid in self.reg.funcs:
            v: V | None = V("func", fid)
        elif fid in self.reg.classes:
            v = V("class", fid)
        elif key in self._defining or depth > 10:
            return None
        else:
            self._defining.add(key)
            expr = self.reg.module_assigns.get(module, {}).get(name)
            v = self.eval_expr(module, None, expr, {}, depth + 1) if expr is not None else None
            if v is None and name in self.reg.module_ann.get(module, {}):
                v = self.type_from_ann(module, self.reg.module_ann[module][name])
            self._defining.discard(key)
        self._defined[key] = v
        return v

    def _call_value(self, module: str, F: Func | None, call: ast.Call, env: Env, depth: int) -> V | None:
        if isinstance(call.func, ast.Attribute):
            base = self.eval_expr(module, F, call.func.value, env, depth + 1)
            if base is not None and base.kind == "graph":
                return None
        callee = self.eval_expr(module, F, call.func, env, depth + 1)
        if callee is None:
            return None
        if callee.kind == "class":
            return V("inst", callee.ref)
        if callee.kind == "dbcall" and len(callee.extra) == 3 and callee.extra[2] in BEANIE_RETURNS_DOC:
            return V("inst", callee.extra[1])  # `s = await Doc.find_one(...)` -> `s` is a Doc
        if callee.kind == "ext" and len(callee.ref) < 120:
            return V("ext", callee.ref + "()")  # an object made by an external library
        if callee.kind == "func":
            f = self.reg.funcs[callee.ref]
            table = self._collection_from_call(callee.ref, call) or self._returned_table(callee.ref)
            if table:
                return V("coll", table)
            if self.graph_def(callee.ref) is not None:
                bound = self._bind(f, call, module, F, env)
                return V("graph", callee.ref, _env_key(bound))
            return self.type_from_ann(f.module, f.node.returns) or self._inferred_return(callee.ref)
        return None

    def _member(self, base: V | None, attr: str) -> V | None:
        if base is None:
            return None
        k = base.kind
        if k == "module":
            res = self.index.resolve_import(base.ref, attr)
            if res is None:
                return None
            return V("module", res[0]) if res[1] is None else self._eval_defined(res[0], res[1], 0)
        if k == "coll":
            op = MONGO_OPS.get(attr)
            return V("dbcall", base.ref, (op,)) if op else None
        if k == "class":
            mid = self.find_method(base.ref, attr)
            if mid:
                return V("func", mid)
            doc = self.beanie_table(base.ref)
            return V("dbcall", doc, (BEANIE_OPS[attr], base.ref, attr)) if doc and attr in BEANIE_OPS else None
        if k == "inst":
            mid = self.find_method(base.ref, attr)
            if mid:
                if self.is_abstract(mid):
                    return V("dispatch", base.ref, (attr,))
                return V("func", mid)
            doc = self.beanie_table(base.ref)
            if doc and attr in BEANIE_OPS:
                return V("dbcall", doc, (BEANIE_OPS[attr], base.ref, attr))
            return self.attr_types(base.ref).get(attr)
        if k == "super":
            cls = self.reg.classes.get(base.ref)
            if cls:
                for b in cls.bases:
                    bv = self.eval_expr(cls.module, None, b, {})
                    if bv is not None and bv.kind == "class":
                        mid = self.find_method(bv.ref, attr)
                        if mid:
                            return V("func", mid)
            return None
        if k == "ext":
            return V("ext", f"{base.ref}.{attr}")
        return None

    def type_from_ann(self, module: str, ann: ast.expr | None) -> V | None:
        if ann is None:
            return None
        key = (module, ast.unparse(ann))
        if key in self._ann:
            return self._ann[key]
        self._ann[key] = None  # recursion guard
        v = self._type_from_ann(module, ann)
        self._ann[key] = v
        return v

    def _type_from_ann(self, module: str, ann: ast.expr) -> V | None:
        if isinstance(ann, ast.Constant) and isinstance(ann.value, str):
            try:
                return self._type_from_ann(module, ast.parse(ann.value, mode="eval").body)
            except SyntaxError:
                return None
        if isinstance(ann, ast.Subscript):
            if _last_name(ann.value) in ("Optional", "Annotated", "Final", "ClassVar", "Awaitable", "Coroutine"):
                inner = ann.slice.elts[-1 if _last_name(ann.value) == "Coroutine" else 0] if isinstance(ann.slice, ast.Tuple) else ann.slice
                return self._type_from_ann(module, inner)
            return None
        if isinstance(ann, ast.BinOp) and isinstance(ann.op, ast.BitOr):
            for side in (ann.left, ann.right):
                if isinstance(side, ast.Constant) and side.value is None:
                    continue
                v = self._type_from_ann(module, side)
                if v is not None:
                    return v
            return None
        if isinstance(ann, (ast.Name, ast.Attribute)):
            v = self.eval_expr(module, None, ann, {})
            if v is not None and v.kind == "class":
                return V("inst", v.ref)
            if v is not None and v.kind == "ext" and not v.ref.startswith(NOISE_EXT_ROOTS) and "()" not in v.ref:
                return V("ext", v.ref + "()")  # an instance of an external library class
        return None

    # ── database access ──────────────────────────────────────────────────
    def _factory_template(self, fid: str) -> list[tuple[str, int | None]] | None:
        """A function like `collection(domain, name)` that returns
        `<something>()[f"{domain}_{name}"]`: the f-string as parts, each either
        literal text or the index of the parameter it interpolates."""
        if fid in self._factories:
            return self._factories[fid]
        self._factories[fid] = None
        f = self.reg.funcs[fid]
        for st in iter_stmts(f.node.body):
            if not (isinstance(st, ast.Return) and st.value is not None):
                continue
            for sub in ast.walk(st.value):
                if not (isinstance(sub, ast.Subscript) and isinstance(sub.value, ast.Call) and isinstance(sub.slice, ast.JoinedStr)):
                    continue
                parts: list[tuple[str, int | None]] = []
                ok = True
                for v in sub.slice.values:
                    if isinstance(v, ast.Constant):
                        parts.append((str(v.value), None))
                    elif isinstance(v, ast.FormattedValue) and isinstance(v.value, ast.Name) and v.value.id in f.params:
                        parts.append(("", f.params.index(v.value.id)))
                    else:
                        ok = False
                if ok and any(i is not None for _, i in parts):
                    self._factories[fid] = parts
                    return parts
        return None

    def _collection_from_call(self, fid: str, call: ast.Call) -> str | None:
        """`collection("quotation", "rows")` -> "mongo:quotation_rows" (literal arguments only)."""
        parts = self._factory_template(fid)
        if parts is None:
            return None
        f = self.reg.funcs[fid]
        node = f.node.args
        positional = [a.arg for a in node.posonlyargs + node.args]
        args: dict[int, str] = {}
        for i, a in enumerate(call.args):
            if isinstance(a, ast.Constant) and isinstance(a.value, str):
                args[i] = a.value
        for k in call.keywords:
            if k.arg in positional and isinstance(k.value, ast.Constant) and isinstance(k.value.value, str):
                args[positional.index(k.arg)] = k.value.value
        name = ""
        for literal, idx in parts:
            if idx is None:
                name += literal
            elif idx in args:
                name += args[idx]
            else:
                return None  # a dynamic collection name — cannot be named statically
        return f"mongo:{name}"

    def _inferred_return(self, fid: str) -> V | None:
        """The instance an un-annotated function returns, read off its `return`
        statements: `def make(): return GraphClient("quotation")` -> a GraphClient."""
        if fid in self._returned_inst:
            return self._returned_inst[fid]
        self._returned_inst[fid] = None  # recursion guard
        f = self.reg.funcs[fid]
        found: V | None = None
        if f.node.returns is None:
            for st in iter_stmts(f.node.body):
                if isinstance(st, ast.Return) and st.value is not None:
                    v = self.eval_expr(f.module, f, st.value, {})
                    if v is not None and v.kind == "inst":
                        found = v
                        break
        self._returned_inst[fid] = found
        return found

    def _returned_table(self, fid: str) -> str | None:
        """A helper like `def _rows(): return collection("quotation", "rows")`."""
        if fid in self._returned:
            return self._returned[fid]
        self._returned[fid] = None
        f = self.reg.funcs[fid]
        found: str | None = None
        for st in iter_stmts(f.node.body):
            if isinstance(st, ast.Return) and isinstance(st.value, ast.Call):
                v = self.eval_expr(f.module, f, st.value, {})
                if v is not None and v.kind == "coll":
                    found = v.ref
                    break
        self._returned[fid] = found
        return found

    def beanie_table(self, cid: str, seen: frozenset[str] = frozenset()) -> str | None:
        """`class ChatSession(Document)` -> "mongo:ChatSession" (the Database view's id)."""
        if cid in self._beanie:
            return self._beanie[cid]
        cls = self.reg.classes.get(cid)
        if cls is None or cid in seen:
            return None
        found: str | None = None
        for b in cls.bases:
            bv = self.eval_expr(cls.module, None, b, {})
            if bv is None:
                continue
            if bv.kind == "ext" and bv.ref.startswith("beanie") and bv.ref.endswith("Document"):
                found = f"mongo:{cls.name}"
            elif bv.kind == "class":
                inherited = self.beanie_table(bv.ref, seen | {cid})
                if inherited:
                    found = f"mongo:{cls.name}"
            if found:
                break
        self._beanie[cid] = found
        return found

    # ── static string values (for Cypher labels / relationship types) ────
    def _cross(self, a: list[str], b: list[str]) -> list[str]:
        return list(dict.fromkeys(x + y for x in a for y in b))[:MAX_TEMPLATES]

    def str_templates(self, module: str, F: Func | None, expr: ast.AST | None, env: Env, depth: int = 0) -> list[str]:
        """Every string `expr` may evaluate to, with UNKNOWN standing in for any
        part that cannot be determined statically. Follows constants, local and
        module-level assignments, literal arguments bound by callers, `self.x`
        set in the class, and `DICT.get(key, default)` / `DICT[key]` on a
        module-level dict (all of its values)."""
        if depth > 8 or expr is None:
            return [UNKNOWN]
        if isinstance(expr, ast.Constant):
            return [expr.value] if isinstance(expr.value, str) else [UNKNOWN]
        if isinstance(expr, ast.JoinedStr):
            # The same placeholder written twice (`(a:{label})-[]->(b:{label})`) is one value
            # at runtime, so it must take the same candidate in both places — otherwise a
            # label with candidates {Concept, Entity} would wrongly yield Concept -> Entity too.
            options: dict[str, list[str]] = {}
            for v in expr.values:
                if isinstance(v, ast.FormattedValue):
                    options.setdefault(ast.dump(v.value), self.str_templates(module, F, v.value, env, depth + 1))
            keys = list(options)
            out: list[str] = []
            for combo in itertools.islice(itertools.product(*(options[k] for k in keys)), MAX_TEMPLATES):
                chosen = dict(zip(keys, combo))
                out.append("".join(
                    str(v.value) if isinstance(v, ast.Constant)
                    else chosen[ast.dump(v.value)] if isinstance(v, ast.FormattedValue)
                    else UNKNOWN
                    for v in expr.values
                ))
            return list(dict.fromkeys(out)) or [""]
        if isinstance(expr, ast.BinOp) and isinstance(expr.op, ast.Add):
            return self._cross(
                self.str_templates(module, F, expr.left, env, depth + 1),
                self.str_templates(module, F, expr.right, env, depth + 1),
            )
        if isinstance(expr, ast.Name):
            return self._name_templates(module, F, expr.id, env, depth)
        if isinstance(expr, ast.Attribute) and isinstance(expr.value, ast.Name) and expr.value.id == "self" and F is not None:
            return self._self_attr_templates(F, expr.attr, depth)
        if isinstance(expr, ast.Attribute) and F is not None:
            # `client.label` where `client` is a parameter / local of a known class
            base = self.eval_expr(module, F, expr.value, env)
            if base is not None and base.kind == "inst":
                return self._class_attr_templates(base.ref, expr.attr, depth)
        if isinstance(expr, ast.Call) and isinstance(expr.func, ast.Attribute) and expr.func.attr == "get" and expr.args:
            values = self._dict_values(module, expr.func.value)
            if values is not None:
                out = list(values)
                if len(expr.args) > 1:
                    out += self.str_templates(module, F, expr.args[1], env, depth + 1)
                return list(dict.fromkeys(out))[:MAX_TEMPLATES]
        if isinstance(expr, ast.Subscript):
            values = self._dict_values(module, expr.value)
            if values is not None:
                return values[:MAX_TEMPLATES]
        return [UNKNOWN]

    def _name_templates(self, module: str, F: Func | None, name: str, env: Env, depth: int) -> list[str]:
        f = F
        while f is not None:
            if name in f.params:
                bound = env.get((f.id, name))
                return [bound.ref] if bound is not None and bound.kind == "str" else [UNKNOWN]
            assigns, _ = f.locals()
            if name in assigns:
                return self.str_templates(f.module, f, assigns[name], env, depth + 1)
            if name in f.loop_vars():
                return self._iter_templates(f.module, f, f.loop_vars()[name], env, depth + 1)
            if name in f.imports:  # `from x import EV_ITEM` done inside the function
                target = self.index.resolve_import(*f.imports[name])
                if target and target[1]:
                    expr = self.reg.module_assigns.get(target[0], {}).get(target[1])
                    return self.str_templates(target[0], None, expr, {}, depth + 1) if expr is not None else [UNKNOWN]
            f = self.reg.funcs.get(f.parent_id) if f.parent_id else None
        return self._module_templates(module, name, depth)

    def _iter_templates(self, module: str, F: Func | None, expr: ast.AST, env: Env, depth: int) -> list[str]:
        """Every string an iteration variable may take: `for q in (A, B, "…")` / `for q in QUERIES`."""
        if depth > 8:
            return [UNKNOWN]
        if isinstance(expr, ast.Call) and isinstance(expr.func, ast.Name) and expr.func.id in ("sorted", "list", "tuple", "set", "frozenset", "reversed") and expr.args:
            return self._iter_templates(module, F, expr.args[0], env, depth + 1)
        if isinstance(expr, ast.Name):
            imports = {}
            g = F
            while g is not None:  # imports done inside the function, then the module's own
                imports = {**g.imports, **imports}
                g = self.reg.funcs.get(g.parent_id) if g.parent_id else None
            mod = self.index.modules.get(module)
            if mod is not None:
                imports = {**mod.imports, **imports}
            target_module, target = module, expr.id
            if expr.id in imports:
                res = self.index.resolve_import(*imports[expr.id])
                if not res or res[1] is None:
                    return [UNKNOWN]
                target_module, target = res
            node = self.reg.module_assigns.get(target_module, {}).get(target)
            return self._iter_templates(target_module, None, node, env, depth + 1) if node is not None else [UNKNOWN]
        if isinstance(expr, (ast.List, ast.Tuple, ast.Set)):
            out: list[str] = []
            for el in expr.elts:
                out.extend(self.str_templates(module, F, el, env, depth + 1))
            return list(dict.fromkeys(out))[:MAX_TEMPLATES] or [UNKNOWN]
        return [UNKNOWN]

    def _module_templates(self, module: str, name: str, depth: int) -> list[str]:
        mod = self.index.modules.get(module)
        if mod is None:
            return [UNKNOWN]
        target_module, target = module, name
        if name in mod.imports:
            res = self.index.resolve_import(*mod.imports[name])
            if not res or res[1] is None:
                return [UNKNOWN]
            target_module, target = res
        expr = self.reg.module_assigns.get(target_module, {}).get(target)
        return self.str_templates(target_module, None, expr, {}, depth + 1) if expr is not None else [UNKNOWN]

    def _self_attr_templates(self, F: Func, attr: str, depth: int) -> list[str]:
        """`self.label` -> what the class assigns to it (in __init__ first)."""
        return self._class_attr_templates(F.class_id or "", attr, depth)

    def _class_attr_templates(self, cid: str, attr: str, depth: int) -> list[str]:
        """What a class assigns to `attr`: a class-level constant, or `self.attr = …` in its methods."""
        cls = self.reg.classes.get(cid)
        if cls is None:
            return [UNKNOWN]
        for st in cls.node.body:  # class-level `label = "X"`
            if isinstance(st, ast.Assign) and any(isinstance(t, ast.Name) and t.id == attr for t in st.targets):
                return self.str_templates(cls.module, None, st.value, {}, depth + 1)
        for mid in sorted(cls.methods.values(), key=lambda m: m.split(".")[-1] != "__init__"):
            m = self.reg.funcs[mid]
            for st in iter_stmts(m.node.body):
                if isinstance(st, ast.Assign):
                    for t in st.targets:
                        if isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name) and t.value.id == "self" and t.attr == attr:
                            return self.str_templates(m.module, m, st.value, {}, depth + 1)
        return [UNKNOWN]

    def _dict_values(self, module: str, expr: ast.AST) -> list[str] | None:
        """All string values of a dict literal (directly, or via a module-level name)."""
        node: ast.AST | None = expr
        if isinstance(expr, ast.Name):
            mod = self.index.modules.get(module)
            target_module, target = module, expr.id
            if mod is not None and expr.id in mod.imports:
                res = self.index.resolve_import(*mod.imports[expr.id])
                if not res or res[1] is None:
                    return None
                target_module, target = res
            node = self.reg.module_assigns.get(target_module, {}).get(target)
        if not isinstance(node, ast.Dict):
            return None
        values = [v.value for v in node.values if isinstance(v, ast.Constant) and isinstance(v.value, str)]
        return list(dict.fromkeys(values)) or None

    def _string_exprs(self, F: Func):
        """Maximal string expressions in the function's own body: literals,
        f-strings and `a + b` concatenations (docstring / nested defs excluded)."""
        first = F.node.body[0] if F.node.body else None
        # the docstring is an expression statement that is *just* a string — a first
        # statement like `session.run("MATCH …")` is code and must be scanned
        doc = first if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str) else None

        def is_str(n: ast.AST) -> bool:
            if isinstance(n, ast.Constant):
                return isinstance(n.value, str)
            if isinstance(n, ast.JoinedStr):
                return True
            return isinstance(n, ast.BinOp) and isinstance(n.op, ast.Add) and (is_str(n.left) or is_str(n.right))

        def walk(node: ast.AST):
            for child in ast.iter_child_nodes(node):
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)) or child is doc:
                    continue
                if is_str(child):
                    yield child
                    continue
                if (
                    isinstance(child, ast.Call) and isinstance(child.func, ast.Attribute) and child.func.attr == "run"
                    and child.args and isinstance(child.args[0], (ast.Name, ast.Attribute))
                ):
                    yield child.args[0]  # `s.run(statement)`: resolve where `statement` comes from
                yield from walk(child)

        yield from walk(F.node)

    def cypher_accesses(self, F: Func, env: Env) -> list[dict[str, Any]]:
        """Neo4j node labels and relationship types named by the Cypher queries
        in this function's own body, resolved against the bindings in `env`.

        A label that differs between the candidate values of a query is marked
        `uncertain` ("one of ..."); one that could not be resolved at all
        becomes an `unattributed` entry."""
        key = (F.id, _env_key(self._filter_env(env, F)))
        if key in self._cypher:
            return self._cypher[key]
        results: dict[tuple[str, str], dict[str, Any]] = {}
        for expr in self._string_exprs(F):
            templates = [t for t in self.str_templates(F.module, F, expr, env) if looks_like_cypher(t)]
            if not templates:
                continue
            n = len(templates)
            counts: dict[tuple[str, str], int] = {}
            dynamic_ops: set[str] = set()
            props: dict[str, set[str]] = {}
            edges: dict[tuple[str, str], dict[tuple[str, str], int]] = {}  # (rel table, op) -> {(from, to): candidates seen in}
            for t in templates:
                facts = extract(t)
                for src, rel, dst in facts.edges:
                    seen = edges.setdefault((f"neo4j-rel:{rel}", facts.op), {})
                    seen[(f"neo4j:{src}", f"neo4j:{dst}")] = seen.get((f"neo4j:{src}", f"neo4j:{dst}"), 0) + 1
                for label, names in facts.label_props.items():
                    props.setdefault(f"neo4j:{label}", set()).update(names)
                for rel, names in facts.rel_props.items():
                    props.setdefault(f"neo4j-rel:{rel}", set()).update(names)
                for label in facts.labels:
                    counts[(f"neo4j:{label}", facts.op)] = counts.get((f"neo4j:{label}", facts.op), 0) + 1
                for rel in facts.rels:
                    counts[(f"neo4j-rel:{rel}", facts.op)] = counts.get((f"neo4j-rel:{rel}", facts.op), 0) + 1
                if facts.dynamic_label or facts.dynamic_rel:
                    dynamic_ops.add(facts.op)
            for (table, op), c in counts.items():
                entry = results.get((table, op))
                if entry is None:
                    entry = results[(table, op)] = {"table": table, "op": op, "uncertain": c < n, "fields": {}}
                else:
                    entry["uncertain"] = entry["uncertain"] and c < n
                for name in props.get(table, ()):
                    entry["fields"].setdefault(name, {"name": name, "type": "any", "source": "cypher"})
                for (frm, to), seen_in in edges.get((table, op), {}).items():
                    known = entry.setdefault("edges", {}).get((frm, to))
                    uncertain_edge = seen_in < n
                    entry["edges"][(frm, to)] = {"from": frm, "to": to, "uncertain": uncertain_edge if known is None else known["uncertain"] and uncertain_edge}
            for op in dynamic_ops:
                results.setdefault(("?", op), {
                    "table": "?", "op": op, "unattributed": True, "line": getattr(expr, "lineno", None),
                    "reason": "a label or relationship type in this query is computed at runtime and could not be resolved",
                })
        out = list(results.values())
        self._cypher[key] = out
        return out

    # ── field inference ──────────────────────────────────────────────────
    def class_fields(self, cid: str, seen: frozenset[str] = frozenset()) -> list[tuple[str, str]]:
        """(name, type) for a model class's annotated attributes, inherited
        ones included: Pydantic models, Beanie documents, dataclasses."""
        if cid in self._class_fields:
            return self._class_fields[cid]
        cls = self.reg.classes.get(cid)
        if cls is None or cid in seen:
            return []
        out: dict[str, str] = {}
        for b in cls.bases:
            bv = self.eval_expr(cls.module, None, b, {})
            if bv is not None and bv.kind == "class":
                out.update(dict(self.class_fields(bv.ref, seen | {cid})))
        for st in cls.node.body:
            if isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name):
                name = st.target.id
                text = ast.unparse(st.annotation)
                if name.startswith("_") or "ClassVar" in text:
                    continue
                out[name] = _short(text, 60)
        result = list(out.items())
        self._class_fields[cid] = result
        return result

    def model_fields(self) -> dict[str, list[dict[str, str]]]:
        """Fields of every Beanie document, keyed by its table id."""
        out: dict[str, list[dict[str, str]]] = {}
        for cid in self.reg.classes:
            table = self.beanie_table(cid)
            if table:
                out[table] = [{"name": n, "type": t, "source": "model"} for n, t in self.class_fields(cid)]
        return out

    def _value_type(self, expr: ast.AST | None) -> str:
        if isinstance(expr, ast.Constant):
            return _PY_TYPES.get(type(expr.value), "any")
        if isinstance(expr, ast.JoinedStr):
            return "string"
        if isinstance(expr, (ast.List, ast.ListComp, ast.Tuple, ast.Set, ast.SetComp)):
            return "array"
        if isinstance(expr, (ast.Dict, ast.DictComp)):
            return "object"
        return "any"

    def _doc_keys(self, F: Func, expr: ast.AST | None, env: Env, depth: int = 0) -> dict[str, str]:
        """Field names (and a guessed type) a document / update expression writes:
        dict literals (including `$set`-style operators), `{**x}` spreads, a
        model's `.model_dump()`, and local variables holding any of these."""
        out: dict[str, str] = {}
        if expr is None or depth > 4:
            return out
        if isinstance(expr, ast.Dict):
            for k, v in zip(expr.keys, expr.values):
                if k is None:  # {**spread}
                    out.update(self._doc_keys(F, v, env, depth + 1))
                elif isinstance(k, ast.Constant) and isinstance(k.value, str):
                    if k.value in UPDATE_OPERATORS:
                        out.update(self._doc_keys(F, v, env, depth + 1))
                    elif not k.value.startswith("$"):
                        out[k.value] = self._value_type(v)
        elif isinstance(expr, (ast.List, ast.Tuple)):
            for el in expr.elts:
                out.update(self._doc_keys(F, el, env, depth + 1))
        elif isinstance(expr, (ast.ListComp, ast.GeneratorExp)):
            out.update(self._doc_keys(F, expr.elt, env, depth + 1))
        elif isinstance(expr, ast.Name):
            assigns, _ = F.locals()
            if expr.id in assigns:
                out.update(self._doc_keys(F, assigns[expr.id], env, depth + 1))
        elif isinstance(expr, ast.Call) and isinstance(expr.func, ast.Attribute) and expr.func.attr in MODEL_DUMPS:
            base = self.eval_expr(F.module, F, expr.func.value, env)
            if base is not None and base.kind == "inst":
                out.update(dict(self.class_fields(base.ref)))
        return out

    def _filter_keys(self, F: Func, expr: ast.AST | None, env: Env, depth: int = 0) -> dict[str, str]:
        """Field names a filter mentions: `{"quotation_id": q, "status": {"$in": [...]}}`."""
        out: dict[str, str] = {}
        if expr is None or depth > 4:
            return out
        if isinstance(expr, ast.Dict):
            for k, v in zip(expr.keys, expr.values):
                if k is None:
                    out.update(self._filter_keys(F, v, env, depth + 1))
                elif isinstance(k, ast.Constant) and isinstance(k.value, str):
                    if k.value in ("$and", "$or", "$nor"):
                        out.update(self._filter_keys(F, v, env, depth + 1))
                    elif not k.value.startswith("$"):
                        out[k.value] = self._value_type(v) if not isinstance(v, ast.Dict) else "any"
        elif isinstance(expr, (ast.List, ast.Tuple)):
            for el in expr.elts:
                out.update(self._filter_keys(F, el, env, depth + 1))
        elif isinstance(expr, ast.Name):
            assigns, _ = F.locals()
            if expr.id in assigns:
                out.update(self._filter_keys(F, assigns[expr.id], env, depth + 1))
        return out

    def call_fields(self, F: Func, call: ast.Call, attr: str, env: Env) -> list[dict[str, str]]:
        """Fields a Motor collection call writes ("write") or queries ("query")."""
        found: dict[str, dict[str, str]] = {}

        def arg(i: int) -> ast.AST | None:
            return call.args[i] if len(call.args) > i else None

        if attr in MONGO_DOC_ARG:
            for name, typ in self._doc_keys(F, arg(MONGO_DOC_ARG[attr]), env).items():
                found[name] = {"name": name, "type": typ, "source": "write"}
        if attr in MONGO_UPDATE_ARG:
            for name, typ in self._doc_keys(F, arg(MONGO_UPDATE_ARG[attr]), env).items():
                found[name] = {"name": name, "type": typ, "source": "write"}
        if attr in MONGO_FILTER_ARG:
            for name, typ in self._filter_keys(F, arg(MONGO_FILTER_ARG[attr]), env).items():
                found.setdefault(name, {"name": name, "type": typ, "source": "query"})
        return list(found.values())

    # ── index definitions ────────────────────────────────────────────────
    def index_definitions(self) -> dict[str, list[dict[str, Any]]]:
        """Indexes and constraints the code creates, per table — read from the code,
        so they cannot drift the way hand-written ones do.

          * Mongo:   `coll.create_index(...)`, `coll.create_indexes([IndexModel(...)])`
          * Beanie:  `class Settings: indexes = [...]`
          * Neo4j:   `CREATE [UNIQUE] INDEX / CONSTRAINT ... FOR (n:Label) ...` in any string,
                     including module-level lists of statements

        Scans the whole project, not only endpoint-reachable code: indexes are usually
        created at startup, by functions no endpoint calls."""
        found: dict[str, dict[tuple, dict[str, Any]]] = {}

        def add(table: str, keys: list[str], unique: bool, kind: str, name: str | None, source: str) -> None:
            if not keys:
                return
            key = (tuple(keys), unique, kind)
            found.setdefault(table, {}).setdefault(key, {
                "name": name or ("idx_" + "_".join(k.lstrip("-") for k in keys)), "keys": keys,
                "unique": unique, "kind": kind, "source": source,
            })

        # Mongo: create_index / create_indexes on a collection handle
        for f in self.reg.funcs.values():
            for node in ast.walk(f.node):
                if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ("create_index", "create_indexes")):
                    continue
                table = self._collection_table(f, node.func.value)
                if table is None or not node.args:
                    continue
                specs = node.args[0].elts if node.func.attr == "create_indexes" and isinstance(node.args[0], (ast.List, ast.Tuple)) else [node]
                for spec in specs:
                    keys, unique, name, ttl = self._mongo_index_spec(spec)
                    add(table, keys, unique, "ttl" if ttl else "index", name, f"{f.file_path}:{node.lineno}")

        # Beanie: class Settings: indexes = [...]
        for cid, cls in self.reg.classes.items():
            table = self.beanie_table(cid)
            if not table:
                continue
            for st in cls.node.body:
                if isinstance(st, ast.ClassDef) and st.name == "Settings":
                    for a in st.body:
                        if isinstance(a, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "indexes" for t in a.targets) and isinstance(a.value, (ast.List, ast.Tuple)):
                            for el in a.value.elts:
                                keys, unique, name, ttl = self._mongo_index_spec(el)
                                add(table, keys, unique, "ttl" if ttl else "index", name, f"{cls.file_path}:{a.lineno}")

        # Neo4j: any string in the project that creates an index / constraint
        for mod in self.index.modules.values():
            for node in ast.walk(mod.tree):
                if isinstance(node, ast.Constant) and isinstance(node.value, str) and "CREATE" in node.value and ("INDEX" in node.value or "CONSTRAINT" in node.value):
                    for table, keys, unique, kind, name in parse_neo4j_schema_statement(node.value):
                        add(table, keys, unique, kind, name, f"{mod.file_path}:{node.lineno}")
        # ... and statements built with f-strings over label constants (`FOR (n:{label})`)
        for f in self.reg.funcs.values():
            for expr in self._string_exprs(f):
                for text in self.str_templates(f.module, f, expr, {}):
                    if "CREATE" in text and ("INDEX" in text or "CONSTRAINT" in text):
                        for table, keys, unique, kind, name in parse_neo4j_schema_statement(text):
                            add(table, keys, unique, kind, name, f"{f.file_path}:{getattr(expr, 'lineno', f.line)}")

        return {t: sorted(d.values(), key=lambda e: (e["kind"], e["keys"])) for t, d in found.items()}

    def _beanie_collection_names(self) -> dict[str, str]:
        """`class Settings: name = "sessions"` -> {"sessions": "mongo:ChatSession"}."""
        out: dict[str, str] = {}
        for cid, cls in self.reg.classes.items():
            table = self.beanie_table(cid)
            if not table:
                continue
            for st in cls.node.body:
                if isinstance(st, ast.ClassDef) and st.name == "Settings":
                    for a in st.body:
                        if isinstance(a, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "name" for t in a.targets) \
                                and isinstance(a.value, ast.Constant) and isinstance(a.value.value, str):
                            out[a.value.value] = table
        return out

    def _collection_table(self, F: Func, expr: ast.AST) -> str | None:
        """The table a collection expression names: a resolved handle, or the raw
        `database["sessions"]` (looked up as a Beanie document's `Settings.name`)."""
        base = self.eval_expr(F.module, F, expr, {})
        if base is not None and base.kind == "coll":
            return base.ref
        node: ast.AST | None = expr
        if isinstance(node, ast.Name):
            assigns, _ = F.locals()
            node = assigns.get(node.id)
        if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant) and isinstance(node.slice.value, str):
            name = node.slice.value
            return self._beanie_collection_names().get(name) or f"mongo:{name}"
        return None

    def _mongo_index_spec(self, spec: ast.AST) -> tuple[list[str], bool, str | None, bool]:
        """`"ts"`, `[("operation", 1), ("ts", -1)]`, `IndexModel([...], unique=True, name="x")`."""
        unique, name, ttl = False, None, False
        node = spec
        if isinstance(spec, ast.Call):  # IndexModel(...) or the create_index(...) call itself
            for k in spec.keywords:
                if k.arg == "unique" and isinstance(k.value, ast.Constant):
                    unique = bool(k.value.value)
                elif k.arg == "name" and isinstance(k.value, ast.Constant) and isinstance(k.value.value, str):
                    name = k.value.value
                elif k.arg == "expireAfterSeconds":
                    ttl = True
            node = spec.args[0] if spec.args else None
        keys: list[str] = []
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            keys = [node.value]
        elif isinstance(node, (ast.List, ast.Tuple)):
            for el in node.elts:
                if isinstance(el, ast.Constant) and isinstance(el.value, str):
                    keys.append(el.value)
                elif isinstance(el, ast.Tuple) and el.elts and isinstance(el.elts[0], ast.Constant) and isinstance(el.elts[0].value, str):
                    direction = el.elts[1] if len(el.elts) > 1 else None
                    descending = (
                        (isinstance(direction, ast.UnaryOp) and isinstance(direction.op, ast.USub))  # -1
                        or (isinstance(direction, ast.Attribute) and direction.attr == "DESCENDING")  # pymongo.DESCENDING
                        or (isinstance(direction, ast.Name) and direction.id == "DESCENDING")  # from pymongo import DESCENDING
                    )
                    keys.append(("-" if descending else "") + el.elts[0].value)
        return keys, unique, name, ttl

    # ── classes ──────────────────────────────────────────────────────────
    def find_method(self, cid: str, name: str, seen: frozenset[str] = frozenset()) -> str | None:
        cls = self.reg.classes.get(cid)
        if cls is None or cid in seen:
            return None
        if name in cls.methods:
            return cls.methods[name]
        for b in cls.bases:
            bv = self.eval_expr(cls.module, None, b, {})
            if bv is not None and bv.kind == "class":
                found = self.find_method(bv.ref, name, seen | {cid})
                if found:
                    return found
        return None

    def is_abstract(self, mid: str) -> bool:
        f = self.reg.funcs[mid]
        if not f.is_stub or f.class_id is None:
            return False
        cls = self.reg.classes[f.class_id]
        return cls.is_protocol or any("abstractmethod" in d for d in f.decorators) or any(
            _last_name(b) in ("ABC", "Protocol") for b in cls.bases
        )

    def attr_types(self, cid: str) -> dict[str, V]:
        if cid in self._attr_types:
            return self._attr_types[cid]
        out: dict[str, V] = {}
        self._attr_types[cid] = out
        cls = self.reg.classes.get(cid)
        if cls is None:
            return out
        for st in cls.node.body:
            if isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name):
                t = self.type_from_ann(cls.module, st.annotation)
                if t is not None:
                    out[st.target.id] = t
        for mid in sorted(cls.methods.values(), key=lambda m: m.split(".")[-1] != "__init__"):
            f = self.reg.funcs[mid]
            for st in iter_stmts(f.node.body):
                targets: list[ast.expr] = []
                value: ast.expr | None = None
                if isinstance(st, ast.Assign):
                    targets, value = list(st.targets), st.value
                elif isinstance(st, ast.AnnAssign):
                    targets, value = [st.target], st.value
                for t in targets:
                    if isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name) and t.value.id == "self" and t.attr not in out:
                        v = self.eval_expr(f.module, f, value, {}) if value is not None else None
                        if v is None and isinstance(st, ast.AnnAssign):
                            v = self.type_from_ann(f.module, st.annotation)
                        if v is not None and v.kind in ("inst", "func", "graph", "ext"):
                            out[t.attr] = v
        return out

    def _subclasses(self) -> dict[str, set[str]]:
        if self._subclass_cache is None:
            subs: dict[str, set[str]] = {}
            for cid, cls in self.reg.classes.items():
                for b in cls.bases:
                    bv = self.eval_expr(cls.module, None, b, {})
                    if bv is not None and bv.kind == "class":
                        subs.setdefault(bv.ref, set()).add(cid)
            self._subclass_cache = subs
        return self._subclass_cache

    def implementations(self, cid: str, attr: str) -> list[str]:
        """Concrete method ids implementing a Protocol/ABC method."""
        key = (cid, attr)
        if key in self._impls:
            return self._impls[key]
        found: list[str] = []
        subs = self._subclasses()
        seen: set[str] = set()
        todo = list(subs.get(cid, ()))
        while todo:
            c = todo.pop()
            if c in seen:
                continue
            seen.add(c)
            todo.extend(subs.get(c, ()))
            mid = self.find_method(c, attr)
            if mid and not self.is_abstract(mid):
                found.append(mid)
        cls = self.reg.classes[cid]
        if cls.is_protocol and not found:
            wanted = {m for m in cls.methods if not m.startswith("_")}
            for other_id, other in self.reg.classes.items():
                if other_id == cid or other.is_protocol:
                    continue
                if wanted and all((mm := self.find_method(other_id, m)) and not self.is_abstract(mm) for m in wanted):
                    mid = self.find_method(other_id, attr)
                    if mid:
                        found.append(mid)
        found = sorted(set(found))[:10]
        self._impls[key] = found
        return found

    # ── LangGraph ────────────────────────────────────────────────────────
    def graph_def(self, fid: str) -> GraphDef | None:
        if fid in self._graph_defs:
            return self._graph_defs[fid]
        self._graph_defs[fid] = None
        f = self.reg.funcs[fid]
        var: str | None = None
        for st in iter_stmts(f.node.body):
            if isinstance(st, ast.Assign) and isinstance(st.value, ast.Call) and _last_name(st.value.func) in GRAPH_CTORS:
                if isinstance(st.targets[0], ast.Name):
                    var = st.targets[0].id
        if var is None:
            return None
        compiled = False
        nodes: dict[str, ast.expr] = {}
        edges: list[tuple[str, str]] = []
        cond: list[tuple[str, ast.expr, dict[str, str]]] = []
        entry: str | None = None

        def nm(e: ast.expr) -> str | None:
            if isinstance(e, ast.Constant) and isinstance(e.value, str):
                return e.value
            if isinstance(e, ast.Name):
                return {"START": "__start__", "END": "__end__"}.get(e.id, e.id)
            return None

        for st in iter_stmts(f.node.body):
            if isinstance(st, ast.Return) and st.value is not None:
                for sub in ast.walk(st.value):
                    if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Attribute) and sub.func.attr == "compile":
                        compiled = True
            if not (isinstance(st, ast.Expr) and isinstance(st.value, ast.Call) and isinstance(st.value.func, ast.Attribute)):
                continue
            c = st.value
            if not (isinstance(c.func.value, ast.Name) and c.func.value.id == var):
                continue
            a = c.args
            m = c.func.attr
            if m == "add_node":
                if len(a) >= 2 and (n := nm(a[0])):
                    nodes[n] = a[1]
                elif len(a) == 1 and isinstance(a[0], ast.Name):
                    nodes[a[0].id] = a[0]
            elif m == "set_entry_point" and a:
                entry = nm(a[0])
            elif m == "add_edge" and len(a) >= 2 and (x := nm(a[0])) and (y := nm(a[1])):
                edges.append((x, y))
                if x == "__start__" and entry is None:
                    entry = y
            elif m == "add_conditional_edges" and len(a) >= 2 and (x := nm(a[0])):
                mapping: dict[str, str] = {}
                mp = a[2] if len(a) > 2 else next((k.value for k in c.keywords if k.arg in ("path_map", "then")), None)
                if isinstance(mp, ast.Dict):
                    for k, v in zip(mp.keys, mp.values):
                        kk, vv = (nm(k) if k else None), nm(v)
                        if kk and vv:
                            mapping[kk] = vv
                elif isinstance(mp, (ast.List, ast.Tuple)):
                    for el in mp.elts:
                        if (n := nm(el)):
                            mapping[n] = n
                cond.append((x, a[1], mapping))
        if not compiled:
            return None
        gd = GraphDef(fid, nodes, edges, cond, entry)
        self._graph_defs[fid] = gd
        return gd

    def _graph_node(self, gv: V, stack: tuple[str, ...], hits: set[str], call: ast.Call | None) -> N:
        gd = self.graph_def(gv.ref)
        assert gd is not None
        B = self.reg.funcs[gv.ref]
        env_b: Env = dict(gv.extra)
        node = N(
            kind="graph", name=B.name, function_id=B.id, file_path=B.file_path, line=B.line, doc=B.doc,
            label="LangGraph", call_expr=_short(ast.unparse(call.func)) if call else None,
            call_line=call.lineno if call else None, edge="call",
        )
        # traversal order: entry -> BFS over edges
        succ: dict[str, list[tuple[str, str | None]]] = {}
        for a, b in gd.edges:
            succ.setdefault(a, []).append((b, None))
        for a, _router, mapping in gd.cond:
            for label, dest in mapping.items():
                succ.setdefault(a, []).append((dest, label))
        order: list[str] = []
        queue = [gd.entry] if gd.entry else []
        while queue:
            cur = queue.pop(0)
            if cur is None or cur in order or cur in ("__start__", "__end__"):
                continue
            order.append(cur)
            queue.extend(d for d, _ in succ.get(cur, []))
        order += [n for n in gd.nodes if n not in order]

        for name in order:
            fexpr = gd.nodes.get(name)
            if fexpr is None:
                continue
            fv = self.eval_expr(B.module, B, fexpr, env_b)
            if fv is None or fv.kind != "func":
                node.children.append(N(kind="unresolved", name=name, label=name, call_expr=_short(ast.unparse(fexpr)), edge="graph_node"))
                continue
            child = self._function_node(fv.ref, self._filter_env(env_b, self.reg.funcs[fv.ref]), stack, hits, "graph_node", None, None)
            child.label = name
            child.meta["graph"] = {
                "name": name,
                "next": [{"to": d, "label": lbl} for d, lbl in succ.get(name, [])],
            }
            node.children.append(child)
            for a, router, mapping in gd.cond:
                if a != name:
                    continue
                rv = self.eval_expr(B.module, B, router, env_b)
                if rv is not None and rv.kind == "func":
                    r = self._function_node(rv.ref, self._filter_env(env_b, self.reg.funcs[rv.ref]), stack, hits, "router", None, None)
                    r.label = f"route after {name}"
                    r.meta["graph"] = {"name": name, "next": [{"to": d, "label": lbl} for lbl, d in mapping.items()]}
                    node.children.append(r)
        return node

    # ── binding & env ────────────────────────────────────────────────────
    def _bind(self, callee: Func, call: ast.Call, module: str, F: Func | None, env: Env) -> Env:
        node = callee.node
        positional = [a.arg for a in node.args.posonlyargs + node.args.args]
        skip = 1 if callee.class_id and not callee.is_static and positional and positional[0] in ("self", "cls") else 0
        out: Env = {}

        def put(name: str, expr: ast.expr) -> None:
            v = self.eval_expr(module, F, expr, env)
            if v is not None and v.kind in ("func", "inst", "class", "graph", "str"):
                out[(callee.id, name)] = v

        for i, a in enumerate(call.args):
            if isinstance(a, ast.Starred):
                break
            if i + skip < len(positional):
                put(positional[i + skip], a)
        for k in call.keywords:
            if k.arg and k.arg in callee.params:
                put(k.arg, k.value)
        return out

    def _filter_env(self, env: Env, callee: Func) -> Env:
        chain: set[str] = set()
        f: Func | None = callee
        while f is not None:
            chain.add(f.id)
            f = self.reg.funcs.get(f.parent_id) if f.parent_id else None
        return {k: v for k, v in env.items() if k[0] in chain}

    # ── call target resolution ───────────────────────────────────────────
    def _targets(self, F: Func, call: ast.Call, env: Env) -> list[tuple]:
        func = call.func
        text = _short(ast.unparse(func))
        if isinstance(func, ast.Attribute):
            base = self.eval_expr(F.module, F, func.value, env) if not (
                isinstance(func.value, ast.Call) and _last_name(func.value.func) == "super"
            ) else None
            if base is not None and base.kind == "graph":
                return [("graph", base)] if func.attr in GRAPH_RUN else []
            v = self.eval_expr(F.module, F, func, env)
            if v is None:
                if func.attr in UNTYPED_DB_ATTRS:
                    return self._tx_callback(F, call, env, func.attr) or [("dbunknown", func.attr, text)]
                if func.attr in NOISE_ATTRS or func.attr.startswith("__"):
                    return []
                if base is not None and base.kind == "inst" and self._has_external_base(base.ref):
                    return []
                return [("unresolved", text, "")]
        else:
            v = self.eval_expr(F.module, F, func, env)
            if v is None:
                if isinstance(func, ast.Name) and func.id in BUILTIN_NAMES:
                    return []
                return [("unresolved", text, "")]
        if v.kind == "dbcall":
            return [("db", v.ref, v.extra[0], func.attr if isinstance(func, ast.Attribute) else "")]
        if v.kind == "func":
            return [("func", v.ref, False)]
        if v.kind == "class":
            init = self.find_method(v.ref, "__init__")
            return [("func", init, True)] if init else [("class", v.ref)]
        if v.kind == "dispatch":
            impls = self.implementations(v.ref, v.extra[0])
            if not impls:
                mid = self.find_method(v.ref, v.extra[0])
                return [("func", mid, False)] if mid else []
            return [("dispatch", v, impls)]
        if v.kind == "ext":
            parts = v.ref.split(".")
            if v.ref.startswith(NOISE_EXT_ROOTS) or parts[0] in BUILTIN_NAMES:
                return []
            if parts[0] == "neo4j" and parts[-1] in NEO4J_RUN_ATTRS:
                return self._tx_callback(F, call, env, parts[-1]) or [("dbunknown", parts[-1], text)]  # session.run(...) / tx.run(...)
            if len(parts) >= 3 and parts[-1] in NOISE_ATTRS:  # os.environ.get, obj.items, ...
                return []
            return [("ext", v.ref)]
        if v.kind == "inst":
            call_m = self.find_method(v.ref, "__call__")
            return [("func", call_m, False)] if call_m else [("unresolved", text, "")]
        if v.kind == "param":
            return [("unresolved", text, "callable parameter — not bound on this path")]
        return [("unresolved", text, "")]

    def _tx_callback(self, F: Func, call: ast.Call, env: Env, attr: str) -> list[tuple] | None:
        """`session.execute_write(work)`: neo4j calls `work(tx)` — the function that runs the
        queries. Follow it, so its Cypher is attributed instead of the call being "unknown"."""
        if attr not in ("execute_read", "execute_write") or not call.args:
            return None
        callback = self.eval_expr(F.module, F, call.args[0], env)
        return [("func", callback.ref, False)] if callback is not None and callback.kind == "func" else None

    def _has_external_base(self, cid: str, seen: frozenset[str] = frozenset()) -> bool:
        cls = self.reg.classes.get(cid)
        if cls is None or cid in seen:
            return False
        for b in cls.bases:
            bv = self.eval_expr(cls.module, None, b, {})
            if bv is None or bv.kind == "ext":
                return True
            if bv.kind == "class" and self._has_external_base(bv.ref, seen | {cid}):
                return True
        return False

    # ── expansion ────────────────────────────────────────────────────────
    def steps(self, F: Func) -> list[Step]:
        if F.id not in self._steps:
            self._steps[F.id] = function_steps(F.node)
        return self._steps[F.id]

    def _function_node(
        self, fid: str, env: Env, stack: tuple[str, ...], hits: set[str], edge: str,
        call: ast.Call | None, awaited: bool | None, instantiate: bool = False,
    ) -> N:
        f = self.reg.funcs[fid]
        node = N(
            kind="function", name=f.qual.split(".<locals>.")[-1] if not instantiate else f.qual.split(".")[0] + "()",
            function_id=fid, file_path=f.file_path, line=f.line, signature=f.signature, is_async=f.is_async,
            doc=f.doc, edge="instantiate" if instantiate else edge,
            call_line=call.lineno if call else None, call_expr=_short(ast.unparse(call)) if call else None,
        )
        if f.is_stub:
            node.meta["stub"] = True
        if fid in stack:
            node.cyclic = True
            hits.add(fid)
            return node
        kids, h = self._expand_function(fid, env, stack)
        node.children = kids
        hits |= h
        return node

    def _expand_function(self, fid: str, env: Env, stack: tuple[str, ...]) -> tuple[list[N], frozenset[str]]:
        key = (fid, _env_key(env))
        cached = self._memo.get(key)
        if cached is not None:
            return cached
        if len(stack) >= MAX_DEPTH:
            return [], frozenset()
        F = self.reg.funcs[fid]
        hits: set[str] = set()
        kids = []
        for acc in self.cypher_accesses(F, env):
            meta: dict[str, Any] = {"op": acc["op"], "engine": "neo4j"}
            for k in ("uncertain", "unattributed", "reason"):
                if acc.get(k):
                    meta[k] = acc[k]
            if acc.get("fields"):
                meta["fields"] = list(acc["fields"].values())
            if acc.get("edges"):
                meta["edges"] = list(acc["edges"].values())
            kids.append(N(
                kind="db", name="(unknown)" if acc["table"] == "?" else acc["table"],
                external=None if acc["table"] == "?" else acc["table"], edge="call",
                call_line=acc.get("line"), meta=meta,
            ))
        kids += self._expand_steps(F, self.steps(F), env, stack + (fid,), hits)
        hits.discard(fid)
        result = (kids, frozenset(hits))
        if not hits:
            self._memo[key] = result
        return result

    def _expand_steps(self, F: Func, steps: list[Step], env: Env, stack: tuple[str, ...], hits: set[str]) -> list[N]:
        out: list[N] = []
        for step in steps:
            if isinstance(step, CallStep):
                edge = "spawn" if step.role == "spawn" else ("await" if step.awaited else "call")
                for t in self._targets(F, step.call, env):
                    for node in self._target_nodes(t, F, step.call, env, stack, hits, edge):
                        prev = out[-1] if out else None
                        if (
                            prev is not None and node.kind in ("external", "class", "unresolved", "db")
                            and prev.kind == node.kind and prev.name == node.name and prev.edge == node.edge
                            and prev.meta.get("op") == node.meta.get("op")
                        ):
                            prev.meta["count"] = prev.meta.get("count", 1) + 1
                            if node.meta.get("fields"):  # keep what the merged call inferred too
                                known = {f["name"] for f in prev.meta.get("fields", [])}
                                prev.meta.setdefault("fields", []).extend(f for f in node.meta["fields"] if f["name"] not in known)
                        else:
                            out.append(node)
            elif isinstance(step, RefStep):
                v = self.eval_expr(F.module, F, step.expr, env)
                if v is not None and v.kind == "func":
                    callee = self.reg.funcs[v.ref]
                    out.append(self._function_node(v.ref, self._filter_env(env, callee), stack, hits, "callback", None, None))
            elif isinstance(step, DependsStep):
                v = self.eval_expr(F.module, F, step.expr, env)
                text = _short(ast.unparse(step.expr))
                if v is not None and v.kind == "func":
                    out.append(self._function_node(v.ref, {}, stack, hits, "depends", None, None))
                elif v is not None and v.kind == "class":
                    init = self.find_method(v.ref, "__init__")
                    out.append(self._function_node(init, {}, stack, hits, "depends", None, None, True) if init else N(kind="class", name=v.ref.split(":")[-1], edge="depends"))
                else:
                    out.append(N(kind="unresolved", name=text, edge="depends", call_expr=f"Depends({text})", call_line=step.line))
            elif isinstance(step, LoopStep):
                kids = self._expand_steps(F, step.body, env, stack, hits)
                if kids:
                    out.append(N(kind="loop", name=step.kind, label=step.header, call_line=step.line, children=kids, meta={"loop_kind": step.kind}))
            elif isinstance(step, BranchStep):
                arms: list[N] = []
                for label, body in step.arms:
                    kids = self._expand_steps(F, body, env, stack, hits)
                    if kids:
                        arms.append(N(kind="arm", name=label, label=label, children=kids))
                if arms:
                    out.append(N(kind="branch", name=step.kind, label=step.kind, call_line=step.line, children=arms, meta={"branch_kind": step.kind}))
        return out

    def _target_nodes(
        self, t: tuple, F: Func, call: ast.Call, env: Env, stack: tuple[str, ...], hits: set[str], edge: str,
    ) -> list[N]:
        kind = t[0]
        text = _short(ast.unparse(call))
        if kind == "func":
            callee = self.reg.funcs[t[1]]
            new_env = {**self._filter_env(env, callee), **self._bind(callee, call, F.module, F, env)}
            return [self._function_node(callee.id, new_env, stack, hits, edge, call, None, t[2])]
        if kind == "dispatch":
            v: V = t[1]
            wrapper = N(
                kind="dispatch", name=f"{v.ref.split(':')[-1]}.{v.extra[0]}", label="dispatch", edge=edge,
                call_line=call.lineno, call_expr=text,
            )
            for mid in t[2]:
                callee = self.reg.funcs[mid]
                new_env = {**self._filter_env(env, callee), **self._bind(callee, call, F.module, F, env)}
                wrapper.children.append(self._function_node(mid, new_env, stack, hits, "call", call, None))
            return [wrapper]
        if kind == "db":
            op = t[2]
            if op == "write" and any(k.arg == "upsert" and isinstance(k.value, ast.Constant) and k.value.value is True for k in call.keywords):
                op = "upsert"
            meta: dict[str, Any] = {"op": op}
            if len(t) > 3 and t[1].startswith("mongo:"):
                fields = self.call_fields(F, call, t[3], env)
                if fields:
                    meta["fields"] = fields
            return [N(kind="db", name=t[1], external=t[1], edge=edge, call_line=call.lineno, call_expr=text, meta=meta)]
        if kind == "dbunknown":
            if any(p in QUERY_PARAMS for p in F.params):
                return []  # a generic executor: its callers own the queries
            attr = t[1]
            op = MONGO_OPS.get(attr) or {"execute_read": "read", "execute_write": "write"}.get(attr, "unknown")
            return [N(
                kind="db", name="(unknown)", edge=edge, call_line=call.lineno, call_expr=text,
                meta={"op": op, "unattributed": True, "via": attr,
                      "reason": "a database call on an object whose type could not be determined"},
            )]
        if kind == "ext":
            return [N(kind="external", name=t[1].split(".")[-1] if False else t[1], external=t[1], edge=edge, call_line=call.lineno, call_expr=text)]
        if kind == "class":
            cid = t[1]
            cls = self.reg.classes[cid]
            return [N(kind="class", name=cls.name + "()", file_path=cls.file_path, line=cls.line, edge="instantiate", call_line=call.lineno, call_expr=text, external=None)]
        if kind == "graph":
            return [self._graph_node(t[1], stack, hits, call)]
        return [N(kind="unresolved", name=t[1], edge=edge, call_line=call.lineno, call_expr=text, meta={"reason": t[2]} if t[2] else {})]

    # ── endpoint tree ────────────────────────────────────────────────────
    def endpoint_root(self, ep: Endpoint) -> N | None:
        """The full (shared-subtree) hierarchy for one endpoint, or None if
        its handler is not in the project."""
        handler = self.reg.funcs.get(ep.handler_id)
        if handler is None:
            return None
        env: Env = {}
        if ep.factory:
            for name, fid in ep.bindings.items():
                if fid and fid in self.reg.funcs:
                    env[(ep.factory, name)] = V("func", fid)
        hits: set[str] = set()
        root = N(
            kind="function", name=handler.name, function_id=handler.id, file_path=handler.file_path,
            line=handler.line, signature=handler.signature, is_async=handler.is_async, doc=handler.doc,
            edge="handler", label=f"{ep.method} {ep.path}",
        )
        for dep in ep.dependency_ids:
            if dep in self.reg.funcs:
                root.children.append(self._function_node(dep, {}, (handler.id,), hits, "depends", None, None))
        kids, _ = self._expand_function(handler.id, self._filter_env(env, handler), ())
        root.children.extend(kids)
        return root

    def endpoint_tree(self, ep: Endpoint, depth: int | None = None) -> dict[str, Any]:
        root = self.endpoint_root(ep)
        if root is None:
            return {"error": f"handler {ep.handler_id} not found in project"}
        return {"endpoint_id": ep.id, "root": render(root, "0", depth), "stats": tree_stats(root)}


def tree_stats(root: N) -> dict[str, Any]:
    """Counts over every node *position* of the tree (shared subtrees count
    once per occurrence). coverage = identified calls / (identified + unresolved)."""
    stats: dict[str, Any] = {
        "function": 0, "external": 0, "unresolved": 0, "class": 0, "loop": 0, "branch": 0,
        "graph": 0, "dispatch": 0, "cyclic": 0, "max_depth": 0,
    }
    todo: list[tuple[N, int]] = [(root, 0)]
    while todo:
        n, depth = todo.pop()
        if n.kind in stats:
            stats[n.kind] += 1
        if n.cyclic:
            stats["cyclic"] += 1
        stats["max_depth"] = max(stats["max_depth"], depth)
        todo.extend((c, depth + 1) for c in n.children)
    known = stats["function"] + stats["external"] + stats["class"]
    stats["coverage"] = round(known / (known + stats["unresolved"]), 3) if known + stats["unresolved"] else 1.0
    stats["nodes"] = sum(stats[k] for k in ("function", "external", "unresolved", "class", "loop", "branch", "graph", "dispatch"))
    return stats


def node_at(root: N, path: str) -> N | None:
    """Resolve a node id like "0.3.1" (index path from the root) to a node."""
    parts = path.split(".")
    if parts[0] != "0":
        return None
    node = root
    for part in parts[1:]:
        if not part.isdigit() or int(part) >= len(node.children):
            return None
        node = node.children[int(part)]
    return node


def render(n: N, path: str, depth: int | None, detail_path: str | None = None) -> dict[str, Any]:
    """Serialize a node. `depth` limits how many levels of children are
    included (None = all); a cut node reports `children_count` instead.

    Payload is kept small: signatures are left out (the function endpoint has
    them), and a node's library-call list is only included for the node at
    `detail_path`; every other node just reports `library_count`."""
    d: dict[str, Any] = {"id": path, "kind": n.kind, "name": n.name}
    if n.kind not in ("loop", "branch", "arm"):
        d["edge"] = n.edge
    for key in ("function_id", "file_path", "line", "doc", "call_line", "call_expr", "label", "external"):
        val = getattr(n, key)
        if val is not None:
            d[key] = val
    if n.is_async:
        d["is_async"] = True
    if n.cyclic:
        d["cyclic"] = True
    if n.meta:
        meta = dict(n.meta)
        if meta.get("data"):
            meta["data"] = [{k: v for k, v in e.items() if k not in ("fields", "edges")} for e in meta["data"]]
        below = meta.pop("below", None)  # the list goes only to the selected node; others carry below_count
        if below and path == detail_path:
            meta["below"] = below
        lib = meta.pop("library", None)
        if lib:
            if path == detail_path:
                meta["library"] = lib
            meta["library_count"] = sum(e["count"] for e in lib) + meta.get("library_more", 0)
        d["meta"] = meta
    if n.children:
        if depth is not None and depth <= 0:
            d["children_count"] = len(n.children)
        else:
            nxt = None if depth is None else depth - 1
            d["children"] = [render(c, f"{path}.{i}", nxt, detail_path) for i, c in enumerate(n.children)]
    return d

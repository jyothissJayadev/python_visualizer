"""backend/analysis/telelog.py — the `@telelog` comment tags written above functions.

A tag is a contiguous run of own-line `#` comments whose first line starts with
`@telelog`, sitting directly above a `def` / `async def` (above any decorators).
Meaning lives in comments only: no imports, no decorators, no runtime effect.
Parsing uses `tokenize` (comments) plus `ast` (where the functions are); target
code is never executed and never modified, and nothing here raises on bad input —
problems are returned as data so one broken tag cannot hide the others.

Grammar (see docs/designs/telelog.md):

    # @telelog id=orders.checkout::checkout role=main feature=Checkout parent=- n=1
    # purpose: Turn a user's cart into a paid order
    # in: cart_id (request body), coupon? (request body)
    # out: order_id, total
    # db: carts(r), orders(w)
    # algo: 1) load cart 2) price it 3) charge

Header values may be quoted (`feature="Order Management"`). An explicit empty list is `-` (`db: -`). A key line may share a
line with others through ` | ` (`in: a (JWT) | out: b`), and a one-line helper puts
`purpose:` straight after the header. Caps and vocabulary are checked by the
validator, not here: the parser only reads what is written.
"""

from __future__ import annotations

import ast
import copy
import hashlib
import io
import re
import tokenize
from dataclasses import dataclass, field
from pathlib import Path

ROLES = ("main", "sub", "helper")
HEADER_KEYS = ("id", "role", "feature", "parent", "n")
BODY_KEYS = ("purpose", "in", "out", "db", "algo")

_KEY_LOOKAHEAD = r"(?=(?:%s)\s*:)" % "|".join(BODY_KEYS)
_HEADER_RE = re.compile(r"^@telelog(?:\s+(?P<rest>.*))?$")
_PIPE_SPLIT = re.compile(r"\s*\|\s*" + _KEY_LOOKAHEAD)
_BODY_START = re.compile(r"\s" + _KEY_LOOKAHEAD)
_SEGMENT = re.compile(r"^(?P<key>%s)\s*:\s*(?P<val>.*)$" % "|".join(BODY_KEYS))
_PAIR = re.compile(r"""(?P<key>\w+)=(?P<val>"[^"]*"|'[^']*'|\S+)""")
_FIELD = re.compile(r"^(?P<name>[^\s(?]+)(?P<opt>\?)?\s*(?:\((?P<src>.*)\))?$")
_DB = re.compile(r"^(?P<table>[^\s(]+)\s*\(\s*(?P<mode>[^)]*?)\s*\)$")
_ALGO_STEP = re.compile(r"\d+\)")


@dataclass
class Problem:
    code: str
    message: str
    line: int


@dataclass
class Field:
    name: str
    optional: bool
    source: str | None
    """Text inside the parentheses, e.g. "request body" or "db:carts"; None when absent."""


@dataclass
class DbUse:
    table: str
    mode: str
    """As written; the validator checks it is r, w or rw."""


@dataclass
class Tag:
    start_line: int
    end_line: int
    id: str | None = None
    """Normalised "module.path:QualName" (the registry's id form)."""
    role: str | None = None
    feature: str | None = None
    parent: str | None = None
    """Normalised parent id, or None for a top-level main (written `-`)."""
    n: int | None = None
    purpose: str | None = None
    inputs: list[Field] | None = None
    outputs: list[Field] | None = None
    db: list[DbUse] | None = None
    algo: list[str] | None = None
    bound: "FuncSite | None" = None
    """The function this block sits directly above; None when it is an orphan block."""
    problems: list[Problem] = field(default_factory=list)


@dataclass
class FuncSite:
    qual: str
    """Registry-style qualname: "Cls.method", "outer.<locals>.inner"."""
    line: int
    """Line of the `def`."""
    anchor: int
    """First line of the definition including decorators; a tag must end on anchor - 1."""


@dataclass
class ParseResult:
    tags: list[Tag] = field(default_factory=list)
    functions: list[FuncSite] = field(default_factory=list)
    problems: list[Problem] = field(default_factory=list)
    """File-level problems (syntax error, tokenizer failure)."""


def normalize_id(raw: str) -> str:
    """"orders.checkout::checkout" -> "orders.checkout:checkout" (the registry's form)."""
    raw = raw.strip()
    return raw.replace("::", ":", 1) if "::" in raw else raw


def split_id(fid: str) -> tuple[str, str] | None:
    """"module.path:QualName" -> (module, qual); None when it has no module part."""
    module, sep, qual = fid.partition(":")
    return (module, qual) if sep and module and qual else None


def _unquote(val: str) -> str:
    return val[1:-1] if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'" else val


def _split_top(text: str) -> list[str]:
    """Split on commas that are not inside parentheses."""
    out: list[str] = []
    depth = 0
    cur: list[str] = []
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        if ch == "," and depth == 0:
            out.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    out.append("".join(cur).strip())
    return [x for x in out if x]


def _fields(text: str, line: int, tag: Tag) -> list[Field]:
    out: list[Field] = []
    for item in _split_top(text):
        m = _FIELD.match(item)
        if not m:
            tag.problems.append(Problem("bad-field", f"cannot read field {item!r}", line))
            continue
        src = m.group("src")
        out.append(Field(m.group("name"), bool(m.group("opt")), src.strip() if src is not None else None))
    return out


def _db_uses(text: str, line: int, tag: Tag) -> list[DbUse]:
    out: list[DbUse] = []
    for item in _split_top(text):
        m = _DB.match(item)
        if not m:
            tag.problems.append(Problem("bad-field", f"cannot read db entry {item!r}", line))
            continue
        out.append(DbUse(m.group("table"), m.group("mode")))
    return out


def _apply(tag: Tag, key: str, val: str, line: int) -> None:
    if getattr(tag, {"in": "inputs", "out": "outputs"}.get(key, key)) is not None:
        tag.problems.append(Problem("duplicate-key", f"{key}: given more than once", line))
        return
    if key in ("in", "out", "db") and val in ("-", "none"):  # explicitly empty
        val = ""
    if key == "purpose":
        tag.purpose = val
    elif key == "in":
        tag.inputs = _fields(val, line, tag)
    elif key == "out":
        tag.outputs = _fields(val, line, tag)
    elif key == "db":
        tag.db = _db_uses(val, line, tag)
    elif key == "algo":
        parts = _ALGO_STEP.split(val)
        tag.algo = [p.strip() for p in parts if p.strip()]


def _segments(text: str, line: int, tag: Tag) -> None:
    for seg in _PIPE_SPLIT.split(text.strip()):
        m = _SEGMENT.match(seg.strip())
        if not m:
            if seg.strip():
                tag.problems.append(Problem("bad-line", f"cannot read {seg.strip()!r}", line))
            continue
        _apply(tag, m.group("key"), m.group("val").strip(), line)


def _header(tag: Tag, rest: str, line: int) -> None:
    """Read `key=value` pairs, then any body segment sharing the header line."""
    body = ""
    m = _BODY_START.search(" " + rest)
    if m:  # match starts on the space before the key, which is the same index in `rest`
        body, rest = rest[m.start():].strip(), rest[: m.start()]
    for pair in _PAIR.finditer(rest):
        key, val = pair.group("key"), _unquote(pair.group("val"))
        if key not in HEADER_KEYS:
            tag.problems.append(Problem("unknown-key", f"unknown header key {key!r}", line))
        elif key == "id":
            tag.id = normalize_id(val)
        elif key == "role":
            tag.role = val
            if val not in ROLES:
                tag.problems.append(Problem("bad-field", f"role must be one of {', '.join(ROLES)}, got {val!r}", line))
        elif key == "feature":
            tag.feature = val
        elif key == "parent":
            tag.parent = None if val == "-" else normalize_id(val)
        elif key == "n":
            try:
                tag.n = int(val)
            except ValueError:
                tag.problems.append(Problem("bad-field", f"n must be an integer, got {val!r}", line))
    if body:
        _segments(body, line, tag)


def _parse_block(lines: list[tuple[int, str]]) -> Tag:
    first_line, first = lines[0]
    tag = Tag(start_line=first_line, end_line=lines[-1][0])
    m = _HEADER_RE.match(first)
    _header(tag, (m.group("rest") or "") if m else "", first_line)
    for lineno, text in lines[1:]:
        _segments(text, lineno, tag)
    return tag


def _own_line_comments(source: str) -> list[tuple[int, str]]:
    out: list[tuple[int, str]] = []
    for tok in tokenize.generate_tokens(io.StringIO(source).readline):
        if tok.type == tokenize.COMMENT and tok.line.lstrip().startswith("#"):
            out.append((tok.start[0], tok.string[1:].strip()))
    return out


def _blocks(comments: list[tuple[int, str]]) -> list[list[tuple[int, str]]]:
    """Contiguous comment runs, cut into blocks at every `@telelog` line; text before the first is ignored."""
    runs: list[list[tuple[int, str]]] = []
    for item in comments:
        if runs and runs[-1][-1][0] + 1 == item[0]:
            runs[-1].append(item)
        else:
            runs.append([item])
    blocks: list[list[tuple[int, str]]] = []
    for run in runs:
        cur: list[tuple[int, str]] | None = None
        for item in run:
            if item[1].startswith("@telelog"):
                cur = [item]
                blocks.append(cur)
            elif cur is not None:
                cur.append(item)
    return blocks


def _sites(tree: ast.AST) -> list[FuncSite]:
    """Every function with the registry's qualname rules, in source order."""
    out: list[FuncSite] = []

    def walk(node: ast.AST, prefix: str, in_func: bool) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                qual = f"{prefix}{child.name}"
                anchor = min([d.lineno for d in child.decorator_list] + [child.lineno])
                out.append(FuncSite(qual, child.lineno, anchor))
                walk(child, f"{qual}.<locals>.", True)
            elif isinstance(child, ast.ClassDef):
                walk(child, f"{prefix}{child.name}.", in_func)
            else:
                walk(child, prefix, in_func)

    walk(tree, "", False)
    return out


def parse_source(source: str) -> ParseResult:
    """Read every `@telelog` block in one module's source and bind it to the function below it."""
    result = ParseResult()
    try:
        tree = ast.parse(source)
        comments = _own_line_comments(source)
    except (SyntaxError, ValueError, tokenize.TokenError, IndentationError) as exc:
        result.problems.append(Problem("syntax-error", f"cannot parse module: {exc}", getattr(exc, "lineno", None) or 0))
        return result
    result.functions = _sites(tree)
    by_anchor: dict[int, FuncSite] = {}
    for site in result.functions:
        by_anchor.setdefault(site.anchor, site)
    for lines in _blocks(comments):
        tag = _parse_block(lines)
        tag.bound = by_anchor.get(tag.end_line + 1)
        if tag.bound is None:
            tag.problems.append(Problem(
                "unbound", "not directly above a function (blank line, other code, or a class in between)", tag.start_line))
        result.tags.append(tag)
    return result


def read_tags(analysis) -> dict[str, ParseResult]:
    """module name -> parsed tags, read fresh from disk (module file paths are relative to the project root)."""
    root = Path(analysis.routes.project_path)
    parsed: dict[str, ParseResult] = {}
    for mod in analysis.index.modules.values():
        try:
            parsed[mod.name] = parse_source((root / mod.file_path).read_text(encoding="utf-8"))
        except OSError:
            continue
    return parsed


def tagged_function_ids(parsed: dict[str, ParseResult]) -> dict[str, Tag]:
    """function id -> its tag, by position (the block sitting directly above it), valid or not."""
    out: dict[str, Tag] = {}
    for module, result in parsed.items():
        for tag in result.tags:
            if tag.bound is not None:
                out[f"{module}:{tag.bound.qual}"] = tag
    return out


# ── validation ───────────────────────────────────────────────────────────────

MAX_PURPOSE = 100
MAX_FIELDS = 5
MAX_ALGO_STEPS = 7
DB_MODES = ("r", "w", "rw")
SOURCE_WORDS = ("request body", "query", "path", "header", "JWT", "config")
SOURCE_PREFIXES = ("db:", "step:", "external:")
"""Fixed vocabulary for where an input comes from."""

REQUIRED = {
    "main": ("purpose", "inputs", "outputs", "db", "algo"),
    "sub": ("purpose", "inputs", "outputs"),
    "helper": ("purpose",),
}
FORBIDDEN = {"sub": ("algo",), "helper": ("inputs", "outputs", "db", "algo")}
_LABEL = {"inputs": "in", "outputs": "out"}


@dataclass
class Issue:
    code: str
    severity: str
    """"error" or "warning"."""
    message: str
    id: str | None = None
    file: str | None = None
    line: int | None = None
    suggestion: str | None = None


@dataclass
class ValidationReport:
    errors: list[Issue] = field(default_factory=list)
    warnings: list[Issue] = field(default_factory=list)
    tagged: int = 0
    functions: int = 0

    def add(self, issue: Issue) -> None:
        (self.errors if issue.severity == "error" else self.warnings).append(issue)

    def codes(self) -> list[str]:
        return [i.code for i in self.errors + self.warnings]


def body_fingerprint(node: ast.AST) -> str:
    """Hash of a function's code that ignores its name, so a pure rename keeps the same value."""
    clone = copy.copy(node)
    clone.name = "_"  # type: ignore[attr-defined]
    return hashlib.sha1(ast.dump(clone, include_attributes=False).encode()).hexdigest()[:16]


def source_ok(src: str) -> bool:
    """One or more comma-separated entries, each from the fixed source vocabulary."""
    parts = [p.strip() for p in src.split(",")]
    return bool(parts) and all(
        p in SOURCE_WORDS or any(p.startswith(pre) and len(p) > len(pre) for pre in SOURCE_PREFIXES) for p in parts
    )


def current_fingerprints(analysis) -> dict[str, str]:
    """function id -> name-independent hash for every function; what a tag is "verified" against."""
    return {fid: body_fingerprint(f.node) for fid, f in analysis.registry.funcs.items()}


def _check_fields(tag: Tag, issue) -> None:
    role = tag.role if tag.role in ROLES else None
    for attr in REQUIRED.get(role or "", ()):
        if getattr(tag, attr) is None:
            issue("missing-field", f"{role} tag needs `{_LABEL.get(attr, attr)}:`")
    for attr in FORBIDDEN.get(role or "", ()):
        if getattr(tag, attr) is not None:
            issue("bad-field", f"`{_LABEL.get(attr, attr)}:` is not allowed on a {role}")
    for attr in ("id", "role", "feature"):
        if getattr(tag, attr) in (None, ""):
            issue("missing-field", f"`{attr}=` is required")
    if role in ("main", "sub") and tag.n is None:
        issue("missing-field", f"{role} tag needs `n=`")
    if role in ("sub", "helper") and tag.parent is None:
        issue("bad-field", f"{role} tag needs a parent id (`-` is only for a top-level main)")
    if tag.purpose is not None and len(tag.purpose) > MAX_PURPOSE:
        issue("over-cap", f"purpose is {len(tag.purpose)} chars, max {MAX_PURPOSE}")
    for attr in ("inputs", "outputs"):
        items = getattr(tag, attr)
        if items is not None and len(items) > MAX_FIELDS:
            issue("over-cap", f"`{_LABEL[attr]}:` has {len(items)} fields, max {MAX_FIELDS}")
    if tag.algo is not None and len(tag.algo) > MAX_ALGO_STEPS:
        issue("over-cap", f"algo has {len(tag.algo)} steps, max {MAX_ALGO_STEPS}")
    for f in tag.inputs or ():
        if f.source is None or not source_ok(f.source):
            issue("unknown-source", f"input {f.name!r}: source {f.source!r} is not in the vocabulary "
                  "(request body, query, path, header, JWT, db:<table>, step:<function>, external:<service>, config)")
    for d in tag.db or ():
        if d.mode not in DB_MODES:
            issue("bad-field", f"db entry {d.table!r}: mode must be r, w or rw, got {d.mode!r}")


def validate_tags(analysis, verified=None, exclude=None) -> ValidationReport:
    """Check every tag against the analysed project.

    verified: function id -> fingerprint recorded when its tag was last verified (enables stale/renamed).
    exclude: optional predicate on a registry Func; excluded functions need no tag.
    """
    verified = verified or {}
    reg = analysis.registry
    report = ValidationReport()
    parsed = read_tags(analysis)
    fingerprints = current_fingerprints(analysis)

    tags_by_id: dict[str, list[tuple[Tag, str]]] = {}
    tagged_ids: set[str] = set()
    for module, result in parsed.items():
        path = analysis.index.modules[module].file_path
        for p in result.problems:
            report.add(Issue(p.code, "error", p.message, file=path, line=p.line or None))
        quals = [s.qual for s in result.functions]
        for tag in result.tags:
            def issue(code, msg, severity="error", _tag=tag, _path=path, **kw):
                report.add(Issue(code, severity, msg, id=_tag.id, file=_path, line=_tag.start_line, **kw))

            for p in tag.problems:
                issue(p.code, p.message)
            if tag.bound is None:
                continue
            expected = f"{module}:{tag.bound.qual}"
            last_site = len(quals) - 1 - quals[::-1].index(tag.bound.qual)
            if result.functions[last_site] is not tag.bound:
                issue("duplicate-id", f"{expected} is defined {quals.count(tag.bound.qual)} times; "
                      "tags bind to the last definition (as the analysis does)")
                continue
            if tag.id and tag.id != expected:
                old_hash = verified.get(tag.id)
                if tag.id not in reg.funcs and old_hash and expected in reg.funcs and fingerprints.get(expected) == old_hash:
                    issue("renamed", f"function is now {expected}; update the tag id", "warning", suggestion=expected)
                else:
                    issue("id-mismatch", f"tag id {tag.id} does not match the function below it ({expected})")
                    continue
            if expected not in reg.funcs:
                issue("orphan-tag", f"{expected} is not tracked by the analysis (nested class method?)")
                continue
            fid = expected
            if fid in tagged_ids:
                issue("duplicate-id", f"{fid} is tagged more than once")
                continue
            tagged_ids.add(fid)
            tags_by_id.setdefault(fid, []).append((tag, path))
            _check_fields(tag, issue)
            if tag.purpose == "?":
                issue("purpose-unknown", "purpose is `?`: a human needs to say why this exists", "warning")
            old = verified.get(fid)
            if old and old != fingerprints[fid]:
                issue("stale", "function body changed since the tag was last verified", "warning")

    report.tagged = len(tagged_ids)
    for fid, f in reg.funcs.items():
        if exclude is not None and exclude(f):
            continue
        report.functions += 1
        if fid not in tagged_ids:
            report.add(Issue("missing-tag", "error", f"{fid} has no @telelog tag", id=fid, file=f.file_path, line=f.line))

    # parent links: must exist, must not loop, should share the parent's feature
    for fid, entries in tags_by_id.items():
        tag, path = entries[0]
        if tag.parent is None:
            continue
        parent = tags_by_id.get(tag.parent)
        if parent is None:
            report.add(Issue("unknown-parent", "error", f"parent {tag.parent} is not a tagged function",
                             id=fid, file=path, line=tag.start_line))
            continue
        seen, cur = {fid}, tag.parent
        while cur is not None and cur in tags_by_id:
            if cur in seen:
                report.add(Issue("parent-cycle", "error", f"parent chain loops through {cur}",
                                 id=fid, file=path, line=tag.start_line))
                break
            seen.add(cur)
            cur = tags_by_id[cur][0][0].parent
        parent_feature = parent[0][0].feature
        if parent_feature and tag.feature and parent_feature != tag.feature:
            report.add(Issue("feature-mismatch", "warning",
                             f"feature {tag.feature!r} differs from parent's {parent_feature!r}",
                             id=fid, file=path, line=tag.start_line))
    return report

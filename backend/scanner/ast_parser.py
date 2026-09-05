"""backend/scanner/ast_parser.py — extracts FunctionInfo/ClassInfo from a
single Python source file using the stdlib `ast` module. No imports of the
target code happen here — pure static analysis (§4, §29.4 of the spec).
"""

from __future__ import annotations

import ast
import hashlib

from backend.scanner.models import ClassInfo, FunctionInfo, ParameterInfo

FunctionNode = ast.FunctionDef | ast.AsyncFunctionDef


def make_function_id(qualified_name: str) -> str:
    return hashlib.sha1(qualified_name.encode("utf-8")).hexdigest()[:16]


def _unparse(node: ast.AST | None) -> str | None:
    if node is None:
        return None
    try:
        return ast.unparse(node)
    except Exception:
        return None


def _parameters(node: FunctionNode) -> list[ParameterInfo]:
    args = node.args
    params: list[ParameterInfo] = []

    posonly = list(args.posonlyargs)
    positional = list(args.args)
    pos_defaults = list(args.defaults)
    # ast.arguments.defaults applies to the tail of posonlyargs + args combined.
    all_positional = posonly + positional
    pad = len(all_positional) - len(pos_defaults)
    padded_defaults: list[ast.expr | None] = [None] * pad + list(pos_defaults)

    for arg, default in zip(posonly, padded_defaults[: len(posonly)]):
        params.append(
            ParameterInfo(
                name=arg.arg,
                annotation=_unparse(arg.annotation),
                default=_unparse(default),
                kind="positional_only",
                required=default is None,
            )
        )

    for arg, default in zip(positional, padded_defaults[len(posonly) :]):
        params.append(
            ParameterInfo(
                name=arg.arg,
                annotation=_unparse(arg.annotation),
                default=_unparse(default),
                kind="positional_or_keyword",
                required=default is None,
            )
        )

    if args.vararg is not None:
        params.append(
            ParameterInfo(
                name=args.vararg.arg,
                annotation=_unparse(args.vararg.annotation),
                default=None,
                kind="var_positional",
                required=False,
            )
        )

    for arg, default in zip(args.kwonlyargs, args.kw_defaults):
        params.append(
            ParameterInfo(
                name=arg.arg,
                annotation=_unparse(arg.annotation),
                default=_unparse(default),
                kind="keyword_only",
                required=default is None,
            )
        )

    if args.kwarg is not None:
        params.append(
            ParameterInfo(
                name=args.kwarg.arg,
                annotation=_unparse(args.kwarg.annotation),
                default=None,
                kind="var_keyword",
                required=False,
            )
        )

    return params


def _function_info(
    node: FunctionNode,
    *,
    module: str,
    file_path: str,
    class_name: str | None,
) -> FunctionInfo:
    qualified_name = f"{module}.{class_name}.{node.name}" if class_name else f"{module}.{node.name}"
    return FunctionInfo(
        function_id=make_function_id(qualified_name),
        name=node.name,
        qualified_name=qualified_name,
        file_path=file_path,
        module=module,
        class_name=class_name,
        line_number=node.lineno,
        end_line_number=node.end_lineno or node.lineno,
        parameters=_parameters(node),
        return_annotation=_unparse(node.returns),
        decorators=[_unparse(dec) or "" for dec in node.decorator_list],
        is_async=isinstance(node, ast.AsyncFunctionDef),
        docstring=ast.get_docstring(node),
    )


def parse_source(source: str, *, module: str, file_path: str) -> tuple[list[FunctionInfo], list[ClassInfo]]:
    """Parse one file's source into top-level functions and classes (with
    their methods). Raises SyntaxError on unparseable source — the caller
    (project_scanner) is responsible for catching it per-file so one broken
    file never blocks the rest of the scan (§19)."""
    tree = ast.parse(source, filename=file_path)

    functions: list[FunctionInfo] = []
    classes: list[ClassInfo] = []

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.append(_function_info(node, module=module, file_path=file_path, class_name=None))
        elif isinstance(node, ast.ClassDef):
            methods = [
                _function_info(child, module=module, file_path=file_path, class_name=node.name)
                for child in node.body
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
            ]
            class_qualified_name = f"{module}.{node.name}"
            classes.append(
                ClassInfo(
                    name=node.name,
                    qualified_name=class_qualified_name,
                    file_path=file_path,
                    module=module,
                    line_number=node.lineno,
                    end_line_number=node.end_lineno or node.lineno,
                    decorators=[_unparse(dec) or "" for dec in node.decorator_list],
                    docstring=ast.get_docstring(node),
                    methods=methods,
                )
            )

    return functions, classes

"""backend/runner/argument_builder.py — maps user-provided JSON-compatible
values onto a live function's real signature (via inspect, not the AST
copy), auto-constructing Pydantic BaseModel parameters from dicts so
functions that take request/response schemas — common throughout brain —
are actually runnable, not just browsable.
"""

from __future__ import annotations

import inspect
from typing import Any, Callable

try:
    from pydantic import BaseModel, ValidationError
except ImportError:  # pragma: no cover
    BaseModel = None
    ValidationError = Exception


class ArgumentBuildError(Exception):
    """Raised for a problem with the caller-supplied arguments themselves
    (missing required arg, unexpected arg, bad Pydantic payload) — distinct
    from an exception the target function raises once actually running."""


def build_arguments(func: Callable, provided: dict[str, Any]) -> dict[str, Any]:
    try:
        signature = inspect.signature(func, eval_str=True)
    except Exception:
        # String annotations that reference names not resolvable from the
        # function's own globals (e.g. TYPE_CHECKING-only imports). Fall
        # back to unresolved annotations — Pydantic auto-construction is
        # skipped for those parameters, everything else still works.
        signature = inspect.signature(func)

    parameters = signature.parameters
    has_var_keyword = any(p.kind is inspect.Parameter.VAR_KEYWORD for p in parameters.values())

    unexpected = [name for name in provided if name not in parameters and not has_var_keyword]
    if unexpected:
        raise ArgumentBuildError(f"unexpected argument(s): {', '.join(sorted(unexpected))}")

    resolved: dict[str, Any] = {}
    for name, param in parameters.items():
        if param.kind is inspect.Parameter.VAR_POSITIONAL:
            # No way to populate *args through named JSON arguments — leave
            # it empty. Known v1 limitation, documented in the README.
            continue
        if param.kind is inspect.Parameter.VAR_KEYWORD:
            continue

        if name in provided:
            resolved[name] = _coerce_value(name, provided[name], param.annotation)
        elif param.default is inspect.Parameter.empty:
            raise ArgumentBuildError(f"missing required argument: '{name}'")

    if has_var_keyword:
        for name, value in provided.items():
            if name not in parameters:
                resolved[name] = value

    return resolved


def _coerce_value(name: str, value: Any, annotation: Any) -> Any:
    if annotation is inspect.Parameter.empty or BaseModel is None:
        return value
    if not (isinstance(annotation, type) and issubclass(annotation, BaseModel)):
        return value
    if not isinstance(value, dict):
        return value

    try:
        return annotation(**value)
    except ValidationError as exc:
        raise ArgumentBuildError(f"parameter '{name}': could not build {annotation.__name__} from provided JSON: {exc}")
    except TypeError as exc:
        raise ArgumentBuildError(f"parameter '{name}': could not build {annotation.__name__} from provided JSON: {exc}")

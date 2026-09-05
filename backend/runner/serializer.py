"""backend/runner/serializer.py — turns an arbitrary Python return value
into something JSON-safe, without blindly traversing huge or recursive
object graphs (§13 of the spec). Depth, collection size, and string length
are all bounded and configurable via ExplorerConfig.
"""

from __future__ import annotations

from typing import Any

try:
    from pydantic import BaseModel as _PydanticBaseModel
except ImportError:  # pragma: no cover - pydantic is a hard dependency in practice
    _PydanticBaseModel = None

_JSON_PRIMITIVES = (str, int, float, bool, type(None))


def _truncate_string(value: str, max_length: int) -> str:
    if len(value) <= max_length:
        return value
    return value[:max_length] + f"... [truncated, {len(value)} total chars]"


def safe_serialize(
    value: Any,
    *,
    max_depth: int = 6,
    max_items: int = 200,
    max_string_length: int = 5000,
    expand_objects: bool = True,
    _depth: int = 0,
) -> Any:
    """Turn `value` into JSON-safe data with bounded depth/size.

    `expand_objects=False` stops the generic "walk __dict__" fallback: an
    arbitrary object (ORM row, framework Request, DB client) is rendered as
    just its type + repr, not its attribute tree. Pydantic models,
    dataclasses, dicts and collections are still expanded. Used by the
    tracer, where an argument is often a big framework object and only its
    identity matters.
    """
    if _depth >= max_depth:
        return f"<max depth {max_depth} reached: {type(value).__name__}>"

    if isinstance(value, str):
        return _truncate_string(value, max_string_length)

    if isinstance(value, _JSON_PRIMITIVES):
        return value

    kwargs = dict(
        max_depth=max_depth,
        max_items=max_items,
        max_string_length=max_string_length,
        expand_objects=expand_objects,
        _depth=_depth + 1,
    )

    if isinstance(value, dict):
        items = list(value.items())
        truncated = items[:max_items]
        result = {str(k): safe_serialize(v, **kwargs) for k, v in truncated}
        if len(items) > max_items:
            result["__truncated__"] = f"{len(items) - max_items} more item(s) not shown"
        return result

    if isinstance(value, (list, tuple, set, frozenset)):
        items = list(value)
        truncated = items[:max_items]
        result = [safe_serialize(v, **kwargs) for v in truncated]
        if len(items) > max_items:
            result.append(f"... {len(items) - max_items} more item(s) not shown")
        return result

    if _PydanticBaseModel is not None and isinstance(value, _PydanticBaseModel):
        try:
            return safe_serialize(value.model_dump(mode="json"), **kwargs)
        except Exception:
            pass  # fall through to the generic object representation below

    if hasattr(value, "__dataclass_fields__"):
        try:
            import dataclasses

            return safe_serialize(dataclasses.asdict(value), **kwargs)
        except Exception:
            pass

    if not expand_objects:
        return {
            "type": type(value).__name__,
            "repr": _truncate_string(repr(value), max_string_length),
        }

    # Generic fallback for arbitrary objects (custom classes, ORM objects, etc).
    attributes: dict[str, Any] = {}
    try:
        raw_attrs = vars(value)
        for key, attr_value in list(raw_attrs.items())[:max_items]:
            if key.startswith("_"):
                continue
            try:
                attributes[key] = safe_serialize(attr_value, **kwargs)
            except Exception as exc:
                attributes[key] = f"<unserializable: {exc}>"
    except TypeError:
        pass  # object has no __dict__ (e.g. uses __slots__ with nothing exposed)

    return {
        "type": type(value).__name__,
        "repr": _truncate_string(repr(value), max_string_length),
        "attributes": attributes,
    }

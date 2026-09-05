"""backend/scanner/models.py — typed models describing what static analysis
discovers in a target project. Pydantic so the API layer can return these
directly as JSON responses.
"""

from __future__ import annotations

from pydantic import BaseModel


class ParameterInfo(BaseModel):
    name: str
    annotation: str | None = None
    default: str | None = None
    """Source-text repr of the default value (e.g. "10", '"hello"'), or None
    if the parameter is required."""
    kind: str
    """One of: positional_only, positional_or_keyword, var_positional,
    keyword_only, var_keyword — mirrors inspect.Parameter.kind."""
    required: bool


class FunctionInfo(BaseModel):
    function_id: str
    """Stable id derived from qualified_name — see scanner/project_scanner.py."""
    name: str
    qualified_name: str
    file_path: str
    """Path relative to the project root."""
    module: str
    class_name: str | None = None
    line_number: int
    end_line_number: int
    parameters: list[ParameterInfo]
    return_annotation: str | None = None
    decorators: list[str]
    is_async: bool
    docstring: str | None = None


class ClassInfo(BaseModel):
    name: str
    qualified_name: str
    file_path: str
    module: str
    line_number: int
    end_line_number: int
    decorators: list[str]
    docstring: str | None = None
    methods: list[FunctionInfo]


class ScanError(BaseModel):
    file_path: str
    message: str
    line_number: int | None = None


class ModuleInfo(BaseModel):
    file_path: str
    module: str
    functions: list[FunctionInfo]
    classes: list[ClassInfo]


class ScanResult(BaseModel):
    project_path: str
    modules: list[ModuleInfo]
    errors: list[ScanError]
    scanned_file_count: int

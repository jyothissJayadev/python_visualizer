"""backend/scanner/project_scanner.py — walks a project directory, finds
.py files, parses each with ast_parser, and assembles a ScanResult. A
SyntaxError in one file is recorded as a ScanError and scanning continues
(§19) — one broken file never blocks discovery of the rest of the project.
"""

from __future__ import annotations

import os

from backend.config import ExplorerConfig
from backend.scanner.ast_parser import parse_source
from backend.scanner.models import ModuleInfo, ScanError, ScanResult


def _module_name(relative_path: str) -> str:
    parts = relative_path.replace("\\", "/").split("/")
    if parts[-1] == "__init__.py":
        parts = parts[:-1]
    else:
        parts[-1] = parts[-1][: -len(".py")]
    return ".".join(parts)


def scan_project(config: ExplorerConfig) -> ScanResult:
    project_path = os.path.abspath(config.project_path)
    modules: list[ModuleInfo] = []
    errors: list[ScanError] = []
    scanned_file_count = 0

    for root, dirs, files in os.walk(project_path):
        dirs[:] = [d for d in dirs if not config.should_ignore_dir(d)]

        for filename in files:
            if not filename.endswith(".py"):
                continue

            absolute_path = os.path.join(root, filename)
            relative_path = os.path.relpath(absolute_path, project_path)
            module = _module_name(relative_path)
            scanned_file_count += 1

            try:
                with open(absolute_path, "r", encoding="utf-8") as f:
                    source = f.read()
            except OSError as exc:
                errors.append(ScanError(file_path=relative_path, message=f"could not read file: {exc}"))
                continue

            try:
                functions, classes = parse_source(source, module=module, file_path=relative_path)
            except SyntaxError as exc:
                errors.append(
                    ScanError(
                        file_path=relative_path,
                        message=f"{exc.__class__.__name__}: {exc.msg}",
                        line_number=exc.lineno,
                    )
                )
                continue
            except Exception as exc:  # never let one file crash the whole scan
                errors.append(ScanError(file_path=relative_path, message=f"{exc.__class__.__name__}: {exc}"))
                continue

            if functions or classes:
                modules.append(
                    ModuleInfo(file_path=relative_path, module=module, functions=functions, classes=classes)
                )

    modules.sort(key=lambda m: m.file_path)
    return ScanResult(
        project_path=project_path,
        modules=modules,
        errors=errors,
        scanned_file_count=scanned_file_count,
    )

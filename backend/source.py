"""backend/source.py — reads the exact source lines AST discovered for a
function/class, using the file/line range already recorded on FunctionInfo
(§14). No re-parsing needed here."""

from __future__ import annotations

import os


def read_source_lines(project_path: str, file_path: str, start_line: int, end_line: int) -> str:
    absolute_path = os.path.join(project_path, file_path)
    with open(absolute_path, "r", encoding="utf-8") as f:
        lines = f.readlines()
    return "".join(lines[start_line - 1 : end_line])

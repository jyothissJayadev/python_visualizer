"""Synthetic 'target project' code the tracer tests run against. Lives under
an app/ dir so the default trace-root resolution (<project>/app) is exercised.
"""

from __future__ import annotations


def add(a: int, b: int) -> int:
    return a + b


def scale(value: int, factor: int) -> int:
    doubled = add(value, value)
    return doubled * factor


def boom(label: str) -> None:
    raise ValueError(f"boom: {label}")


def guarded(x: int) -> str:
    try:
        boom("from guarded")
    except ValueError:
        pass
    return f"guarded {scale(x, 3)}"


class Accumulator:
    def __init__(self) -> None:
        self.total = 0

    def push(self, n: int) -> int:
        self.total = add(self.total, n)
        return self.total

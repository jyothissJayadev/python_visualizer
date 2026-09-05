import os
import sys

import pytest

from backend.runner.function_runner import execute_function, prepare_import_environment
from backend.scanner.project_scanner import scan_project
from backend.tracer.monitor import is_supported
from backend.tracer.store import TraceStore

pytestmark = pytest.mark.skipif(not is_supported(), reason="needs sys.monitoring (Python 3.12+)")


def _find_fn(scan_result, name):
    for module in scan_result.modules:
        for fn in module.functions:
            if fn.name == name:
                return fn
    raise AssertionError(f"{name} not scanned")


@pytest.fixture
def scanned(config):
    original_cwd = os.getcwd()
    prepare_import_environment(config)
    try:
        yield scan_project(config)
    finally:
        os.chdir(original_cwd)


def test_execute_with_trace_returns_tree_and_stores_it(config, scanned):
    import asyncio

    fn = _find_fn(scanned, "scale")
    store = TraceStore(capacity=5)
    result = asyncio.run(execute_function(fn, {"value": 6, "factor": 2}, config, trace=True, traces_store=store))

    assert result.success is True
    assert result.output == 24
    assert result.trace is not None
    assert result.trace.kind == "function"
    assert result.trace.roots[0].qualname == "scale"
    assert result.trace.roots[0].children[0].qualname == "add"
    assert store.get(result.trace_id) is not None


def test_execute_without_trace_leaves_trace_none(config, scanned):
    import asyncio

    fn = _find_fn(scanned, "scale")
    result = asyncio.run(execute_function(fn, {"value": 6, "factor": 2}, config))
    assert result.success is True
    assert result.trace is None

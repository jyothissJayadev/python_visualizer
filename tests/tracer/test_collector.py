import asyncio

import pytest

from backend.tracer.collector import TraceCollector
from backend.tracer.monitor import is_supported, trace_session_sync

pytestmark = pytest.mark.skipif(not is_supported(), reason="needs sys.monitoring (Python 3.12+)")


def _collector(config, **overrides):
    kwargs = dict(
        trace_root=config.resolved_trace_root(),
        project_path=config.project_path,
        max_calls=config.max_trace_calls,
        max_depth=config.max_trace_depth,
        value_max_depth=config.trace_value_max_depth,
        max_items=config.max_collection_items,
        max_string_length=config.trace_value_max_string_length,
    )
    kwargs.update(overrides)
    return TraceCollector(**kwargs)


def _find(calls, qualname):
    for call in calls:
        if call.qualname == qualname:
            return call
        hit = _find(call.children, qualname)
        if hit is not None:
            return hit
    return None


def test_sync_nesting_args_and_returns(config):
    from app.calc import scale

    collector = _collector(config)
    with trace_session_sync(collector):
        result = scale(5, 4)

    assert result == 40
    assert len(collector.roots) == 1
    root = collector.roots[0]
    assert root.qualname == "scale"
    assert root.args == {"value": 5, "factor": 4}
    assert root.return_value == 40
    assert root.returned is True

    child = _find(root.children, "add")
    assert child is not None
    assert child.args == {"a": 5, "b": 5}
    assert child.return_value == 10
    assert child.depth == 1
    assert child.file == "app/calc.py"


def test_exception_path_records_unwind_not_return(config):
    from app.calc import guarded

    collector = _collector(config)
    with trace_session_sync(collector):
        out = guarded(2)

    assert out == "guarded 12"
    boom = _find(collector.roots, "boom")
    assert boom is not None
    assert boom.returned is False
    assert boom.exception == "ValueError: boom: from guarded"


def test_async_tree_follows_await(config):
    from app.pipeline import run_pipeline

    collector = _collector(config)
    with trace_session_sync(collector):
        out = asyncio.run(run_pipeline([1, 2]))

    assert out == {"count": 2, "total": 64}
    root = _find(collector.roots, "run_pipeline")
    assert root is not None
    stages = [c for c in root.children if c.qualname == "stage"]
    assert len(stages) == 2
    # fetch is awaited from inside stage -> must nest under it, not become a sibling
    fetch = _find(stages[0].children, "fetch")
    assert fetch is not None
    assert fetch.return_value == 10
    assert stages[0].return_value == 11


def test_receiver_is_summarized_not_expanded(config):
    from app.calc import Accumulator

    collector = _collector(config)
    acc = Accumulator()
    with trace_session_sync(collector):
        acc.push(7)

    push = _find(collector.roots, "Accumulator.push")
    assert push is not None
    assert push.args["n"] == 7
    assert "instance" in push.args["self"]


def test_max_depth_truncates(config):
    from app.calc import scale

    collector = _collector(config, max_depth=0)
    with trace_session_sync(collector):
        scale(1, 1)

    root = collector.roots[0]
    assert root.children == []
    assert root.children_truncated is True


def test_max_calls_truncates(config):
    from app.pipeline import run_pipeline

    collector = _collector(config, max_calls=3)
    with trace_session_sync(collector):
        asyncio.run(run_pipeline([1, 2, 3, 4, 5]))

    assert collector.truncated is True
    assert collector.call_count == 3


def test_only_traces_under_root(config):
    from app.pipeline import run_pipeline

    collector = _collector(config)
    with trace_session_sync(collector):
        asyncio.run(run_pipeline([1]))

    # asyncio.sleep / event loop internals are not under app/ -> never recorded
    assert _find(collector.roots, "sleep") is None
    for call in _iter(collector.roots):
        assert call.module.startswith("app")


def _iter(calls):
    for call in calls:
        yield call
        yield from _iter(call.children)

import asyncio

from backend.runner.function_runner import execute_function
from tests.runner.conftest import find_function


def run(coro):
    return asyncio.run(coro)


def test_execute_simple_sync_function(config, scan_result):
    fn = find_function(scan_result, "calculate_total")
    result = run(execute_function(fn, {"items": [1, 2, 3.5]}, config))
    assert result.success is True
    assert result.output == 6.5
    assert result.duration_ms >= 0


def test_execute_returns_string(config, scan_result):
    fn = find_function(scan_result, "classify_number")
    result = run(execute_function(fn, {"value": -5}, config))
    assert result.success is True
    assert result.output == "negative"


def test_execute_missing_required_argument(config, scan_result):
    fn = find_function(scan_result, "calculate_total")
    result = run(execute_function(fn, {}, config))
    assert result.success is False
    assert result.error_type == "ArgumentBuildError"
    assert "items" in result.error_message


def test_execute_unexpected_argument(config, scan_result):
    fn = find_function(scan_result, "classify_number")
    result = run(execute_function(fn, {"value": 1, "bogus": True}, config))
    assert result.success is False
    assert result.error_type == "ArgumentBuildError"
    assert "bogus" in result.error_message


def test_execute_uses_default_value(config, scan_result):
    fn = find_function(scan_result, "calculate_total_async")
    result = run(execute_function(fn, {"items": [1, 1]}, config))
    assert result.success is True
    assert result.output == 2


def test_execute_async_function(config, scan_result):
    fn = find_function(scan_result, "calculate_total_async")
    result = run(execute_function(fn, {"items": [10, 10], "delay": 0}, config))
    assert result.success is True
    assert result.output == 20


def test_execute_captures_real_exception_with_traceback(config, scan_result):
    fn = find_function(scan_result, "divide")
    result = run(execute_function(fn, {"a": 1, "b": 0}, config))
    assert result.success is False
    assert result.error_type == "ZeroDivisionError"
    assert result.traceback is not None
    assert "divide" in result.traceback


def test_execute_auto_constructs_pydantic_argument(config, scan_result):
    fn = find_function(scan_result, "generate_workflow")
    result = run(
        execute_function(
            fn,
            {"items": [4, 6], "config": {"mode": "commercial"}},
            config,
        )
    )
    assert result.success is True
    assert result.output == {"total": 10, "classification": "positive", "mode": "commercial"}


def test_execute_instance_method_with_default_constructor(config, scan_result):
    fn = find_function(scan_result, "add_and_track", class_name="MathHelper")
    result = run(execute_function(fn, {"a": 2, "b": 3}, config))
    assert result.success is True
    assert result.output == 5


def test_execute_cross_module_dependency_resolves(config, scan_result):
    # generate_workflow imports calculate_total/classify_number from
    # sibling module services.math_service — proves sys.path setup lets the
    # target project's own internal imports resolve, not just the directly
    # requested function's module.
    fn = find_function(scan_result, "generate_workflow")
    result = run(execute_function(fn, {"items": [-1, -2], "config": {}}, config))
    assert result.success is True
    assert result.output["classification"] == "negative"

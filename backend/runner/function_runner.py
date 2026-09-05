"""backend/runner/function_runner.py — resolves a discovered FunctionInfo
to its live callable and executes it, capturing output, timing, and errors.

Scanning (backend/scanner) never imports the target project; this module is
the only place that does, and only for the specific function the user asked
to run (§29.5, §29.6).
"""

from __future__ import annotations

import importlib
import inspect
import sys
import time
import traceback as traceback_module
import uuid
from datetime import datetime, timezone
from typing import Any, Callable

from backend.config import ExplorerConfig
from backend.runner.argument_builder import ArgumentBuildError, build_arguments
from backend.runner.models import ExecutionResult
from backend.runner.serializer import safe_serialize
from backend.scanner.models import FunctionInfo
from backend.tracer.collector import TraceCollector
from backend.tracer.monitor import is_supported, trace_session
from backend.tracer.models import TraceRecord
from backend.tracer.store import TraceStore


class ExecutionSetupError(Exception):
    """Raised when the target function can't even be reached/called — e.g.
    it's an instance method and constructing its class failed."""


def prepare_import_environment(config: ExplorerConfig) -> None:
    """Make the target project importable exactly the way its own code
    expects (§9): project root on sys.path, cwd set so relative file/ .env
    lookups the target performs on its own (e.g. brain's `load_dotenv()`
    with no arguments) resolve the same way they would running the target
    directly. Called once at server startup, not per-request — the target's
    module-level singletons (cached settings, DB clients) are meant to
    persist across calls within one explorer session, same as a normal
    running process.
    """
    import os

    project_path = os.path.abspath(config.project_path)
    if project_path not in sys.path:
        sys.path.insert(0, project_path)
    os.chdir(config.resolved_working_directory())


async def run_startup_hook(startup_hook: str) -> None:
    """Run a one-time "module.path:function_name" hook the target project
    needs before any of its functions will work (e.g. registering ODM
    document models normally done in a FastAPI lifespan). Generic — not
    brain-specific — any target project can configure one or omit it."""
    if ":" not in startup_hook:
        raise ExecutionSetupError(f"invalid startup_hook '{startup_hook}', expected 'module.path:function_name'")
    module_path, _, function_name = startup_hook.partition(":")
    module = importlib.import_module(module_path)
    hook = getattr(module, function_name)
    if inspect.iscoroutinefunction(hook):
        await hook()
    else:
        hook()


def _resolve_callable(function_info: FunctionInfo) -> Callable:
    module = importlib.import_module(function_info.module)

    if function_info.class_name is None:
        return getattr(module, function_info.name)

    cls = getattr(module, function_info.class_name)
    raw_attr = cls.__dict__.get(function_info.name)
    bound = getattr(cls, function_info.name)

    if isinstance(raw_attr, (staticmethod, classmethod)):
        return bound

    try:
        instance = cls()
    except Exception as exc:
        raise ExecutionSetupError(
            f"'{function_info.class_name}.{function_info.name}' is an instance method; constructing "
            f"{function_info.class_name}() with no arguments failed ({type(exc).__name__}: {exc}). "
            "Instance methods whose class needs constructor arguments aren't supported yet."
        )
    return getattr(instance, function_info.name)


async def execute_function(
    function_info: FunctionInfo,
    arguments: dict[str, Any],
    config: ExplorerConfig,
    *,
    trace: bool = False,
    traces_store: TraceStore | None = None,
) -> ExecutionResult:
    start = time.perf_counter()
    collector: TraceCollector | None = None
    trace_record: TraceRecord | None = None
    try:
        func = _resolve_callable(function_info)
        kwargs = build_arguments(func, arguments)

        want_trace = trace and is_supported()
        if want_trace:
            collector = TraceCollector(
                trace_root=config.resolved_trace_root(),
                project_path=config.project_path,
                max_calls=config.max_trace_calls,
                max_depth=config.max_trace_depth,
                value_max_depth=config.trace_value_max_depth,
                max_items=config.max_collection_items,
                max_string_length=config.trace_value_max_string_length,
            )
            started_at = datetime.now(timezone.utc).isoformat()
            call_start = time.perf_counter()
            async with trace_session(collector):
                output = await _invoke(func, kwargs)
            trace_record = collector.build_record(
                trace_id=uuid.uuid4().hex[:12],
                kind="function",
                label=function_info.qualified_name,
                started_at=started_at,
                duration_ms=(time.perf_counter() - call_start) * 1000,
            )
        else:
            output = await _invoke(func, kwargs)

        duration_ms = (time.perf_counter() - start) * 1000
        serialized = safe_serialize(
            output,
            max_depth=config.max_output_depth,
            max_items=config.max_collection_items,
            max_string_length=config.max_string_length,
        )
        if trace_record is not None and traces_store is not None:
            traces_store.add(trace_record)
        return ExecutionResult(
            success=True,
            output=serialized,
            duration_ms=duration_ms,
            trace=trace_record,
            trace_id=trace_record.trace_id if trace_record else None,
        )

    except (ArgumentBuildError, ExecutionSetupError) as exc:
        duration_ms = (time.perf_counter() - start) * 1000
        return ExecutionResult(
            success=False,
            error_type=type(exc).__name__,
            error_message=str(exc),
            traceback=None,
            duration_ms=duration_ms,
        )
    except Exception as exc:
        duration_ms = (time.perf_counter() - start) * 1000
        if collector is not None:
            trace_record = collector.build_record(
                trace_id=uuid.uuid4().hex[:12],
                kind="function",
                label=function_info.qualified_name,
                started_at=datetime.now(timezone.utc).isoformat(),
                duration_ms=duration_ms,
                error=f"{type(exc).__name__}: {exc}",
            )
            if traces_store is not None:
                traces_store.add(trace_record)
        return ExecutionResult(
            success=False,
            error_type=type(exc).__name__,
            error_message=str(exc),
            traceback=traceback_module.format_exc(),
            duration_ms=duration_ms,
            trace=trace_record,
            trace_id=trace_record.trace_id if trace_record else None,
        )


async def _invoke(func: Callable, kwargs: dict[str, Any]) -> Any:
    if inspect.iscoroutinefunction(func):
        return await func(**kwargs)
    return func(**kwargs)

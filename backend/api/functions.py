from __future__ import annotations

import traceback as traceback_module

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend.api.project import get_state
from backend.runner.function_runner import execute_function, run_startup_hook
from backend.runner.models import ExecuteRequest, ExecutionResult
from backend.scanner.models import FunctionInfo
from backend.source import read_source_lines

router = APIRouter()


class FunctionDetail(FunctionInfo):
    source: str


def _all_functions(state) -> list[FunctionInfo]:
    functions: list[FunctionInfo] = []
    for module in state.scan_result.modules:
        functions.extend(module.functions)
        for cls in module.classes:
            functions.extend(cls.methods)
    return functions


@router.get("/api/functions", response_model=list[FunctionInfo])
def list_functions(request: Request) -> list[FunctionInfo]:
    return _all_functions(get_state(request))


@router.get("/api/functions/{function_id}", response_model=FunctionDetail)
def get_function_detail(function_id: str, request: Request) -> FunctionDetail:
    state = get_state(request)
    fn = state.get_function(function_id)
    if fn is None:
        raise HTTPException(status_code=404, detail=f"no function with id '{function_id}' (try rescanning)")

    try:
        source = read_source_lines(state.scan_result.project_path, fn.file_path, fn.line_number, fn.end_line_number)
    except OSError as exc:
        source = f"<could not read source: {exc}>"

    return FunctionDetail(**fn.model_dump(), source=source)


@router.post("/api/functions/{function_id}/execute", response_model=ExecutionResult)
async def execute(function_id: str, body: ExecuteRequest, request: Request) -> ExecutionResult:
    state = get_state(request)
    fn = state.get_function(function_id)
    if fn is None:
        raise HTTPException(status_code=404, detail=f"no function with id '{function_id}' (try rescanning)")

    config = state.config
    if config.startup_hook and not state.startup_hook_ran:
        try:
            await run_startup_hook(config.startup_hook)
            state.startup_hook_ran = True
        except Exception as exc:
            return ExecutionResult(
                success=False,
                error_type=f"StartupHookError:{type(exc).__name__}",
                error_message=f"configured startup_hook '{config.startup_hook}' failed: {exc}",
                traceback=traceback_module.format_exc(),
                duration_ms=0.0,
            )

    return await execute_function(
        fn,
        body.arguments,
        config,
        trace=body.trace,
        traces_store=state.traces,
    )

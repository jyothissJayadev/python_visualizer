"""backend/state.py — the explorer's in-memory state: config + the most
recent scan result, keyed by function_id for O(1) lookup. Rescanning (§17)
just replaces this in place. No persistence, no caching layer beyond this
(§18) — deliberately simple for v1.
"""

from __future__ import annotations

from backend.config import ExplorerConfig
from backend.scanner.models import FunctionInfo, ScanResult
from backend.scanner.project_scanner import scan_project
from backend.tracer.store import TraceStore


class ExplorerState:
    def __init__(self, config: ExplorerConfig, traces: TraceStore | None = None):
        self.config = config
        self.scan_result: ScanResult = ScanResult(project_path=config.project_path, modules=[], errors=[], scanned_file_count=0)
        self._functions_by_id: dict[str, FunctionInfo] = {}
        self.startup_hook_ran = False
        self.traces = traces if traces is not None else TraceStore(capacity=config.max_traces)
        self.rescan()

    def rescan(self) -> ScanResult:
        self.scan_result = scan_project(self.config)
        self._functions_by_id = {}
        for module in self.scan_result.modules:
            for fn in module.functions:
                self._functions_by_id[fn.function_id] = fn
            for cls in module.classes:
                for method in cls.methods:
                    self._functions_by_id[method.function_id] = method
        return self.scan_result

    def get_function(self, function_id: str) -> FunctionInfo | None:
        return self._functions_by_id.get(function_id)

"""backend/tracer/store.py — in-memory ring buffer of recent TraceRecords.

No persistence (consistent with the rest of the explorer's state model —
see backend/state.py). Oldest records are dropped once `capacity` is
reached. Newest-first iteration for the list view.
"""

from __future__ import annotations

from collections import deque
from threading import Lock

from backend.tracer.models import TraceRecord, TraceSummary


class TraceStore:
    def __init__(self, capacity: int = 50) -> None:
        self._records: deque[TraceRecord] = deque(maxlen=max(1, capacity))
        self._lock = Lock()

    def add(self, record: TraceRecord) -> None:
        with self._lock:
            self._records.append(record)

    def summaries(self) -> list[TraceSummary]:
        with self._lock:
            return [TraceSummary.of(r) for r in reversed(self._records)]

    def get(self, trace_id: str) -> TraceRecord | None:
        with self._lock:
            for record in reversed(self._records):
                if record.trace_id == trace_id:
                    return record
        return None

    def clear(self) -> None:
        with self._lock:
            self._records.clear()

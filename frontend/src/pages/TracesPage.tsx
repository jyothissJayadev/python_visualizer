import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { CallTree } from "../components/CallTree";
import type { TraceRecord, TraceSummary } from "../types";

export function TracesPage() {
  const [summaries, setSummaries] = useState<TraceSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TraceRecord | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const loadList = useCallback(async () => {
    try {
      const list = await api.listTraces();
      setSummaries(list);
      setError(null);
      setSelectedId((cur) => cur ?? list[0]?.trace_id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(loadList, 2000);
    return () => clearInterval(id);
  }, [autoRefresh, loadList]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    api
      .getTrace(selectedId)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [selectedId]);

  const handleClear = async () => {
    await api.clearTraces();
    setSelectedId(null);
    setDetail(null);
    await loadList();
  };

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      <aside style={{ width: 340, borderRight: "1px solid #e5e7eb", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "8px 12px", borderBottom: "1px solid #f1f5f9", display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 12, color: "#6b7280", display: "flex", gap: 4, alignItems: "center" }}>
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            auto-refresh
          </label>
          <button onClick={loadList} style={btn}>refresh</button>
          <button onClick={handleClear} style={btn}>clear</button>
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {summaries.length === 0 && (
            <div style={{ padding: 12, color: "#9ca3af", fontSize: 13 }}>
              No traces yet. Send a request through the hosted app (default prefix <code>/app</code>), or run a
              function with "trace nested calls" checked.
            </div>
          )}
          {summaries.map((s) => (
            <button
              key={s.trace_id}
              onClick={() => setSelectedId(s.trace_id)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "8px 12px",
                border: "none",
                borderBottom: "1px solid #f1f5f9",
                background: s.trace_id === selectedId ? "#eef2ff" : "white",
                cursor: "pointer",
              }}
            >
              <div style={{ fontSize: 12, fontFamily: "monospace", color: "#1e293b", wordBreak: "break-all" }}>
                {s.label}
              </div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
                {s.status_code ? `${s.status_code} · ` : ""}
                {s.call_count} calls · {s.duration_ms.toFixed(0)} ms
                {s.truncated ? " · truncated" : ""}
                {s.error ? " · ERROR" : ""}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main style={{ flex: 1, padding: 16, overflowY: "auto" }}>
        {error && <div style={{ color: "#b91c1c", fontSize: 13, marginBottom: 8 }}>{error}</div>}
        {!detail && <div style={{ color: "#9ca3af" }}>Select a trace to see its call tree.</div>}
        {detail && (
          <div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontFamily: "monospace", fontSize: 15, fontWeight: 700 }}>{detail.label}</div>
              <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                {detail.started_at} · {detail.duration_ms.toFixed(1)} ms · {detail.call_count} calls
                {detail.truncated && <span style={{ color: "#b45309" }}> · tree truncated (call cap hit)</span>}
              </div>
              {detail.error && (
                <div style={{ fontSize: 13, color: "#b91c1c", marginTop: 4 }}>Request failed: {detail.error}</div>
              )}
            </div>
            <input
              placeholder="filter by function name…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{
                width: "100%",
                maxWidth: 360,
                padding: "6px 8px",
                border: "1px solid #d1d5db",
                borderRadius: 6,
                fontSize: 13,
                marginBottom: 10,
              }}
            />
            <CallTree roots={detail.roots} filter={filter} />
          </div>
        )}
      </main>
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "4px 10px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  background: "white",
  cursor: "pointer",
  fontSize: 12,
};

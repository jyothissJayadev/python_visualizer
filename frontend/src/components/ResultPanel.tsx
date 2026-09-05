import { useState } from "react";
import type { ExecutionResult } from "../types";
import { CallTree } from "./CallTree";

function TraceSection({ result }: { result: ExecutionResult }) {
  const [filter, setFilter] = useState("");
  if (!result.trace) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>
        CALL TREE — {result.trace.call_count} calls
        {result.trace.truncated && <span style={{ color: "#b45309" }}> (truncated)</span>}
      </div>
      <input
        placeholder="filter by function name…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{ width: "100%", maxWidth: 340, padding: "5px 8px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 12, marginBottom: 8 }}
      />
      <CallTree roots={result.trace.roots} filter={filter} />
    </div>
  );
}

export function ResultPanel({ result }: { result: ExecutionResult | null }) {
  if (!result) {
    return <div style={{ color: "#9ca3af", fontSize: 13 }}>Run a function to see its output here.</div>;
  }

  if (result.success) {
    return (
      <div>
        <div style={{ color: "#16a34a", fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
          SUCCESS — {result.duration_ms.toFixed(1)} ms
        </div>
        <pre
          style={{
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            padding: 12,
            fontSize: 13,
            overflowX: "auto",
            margin: 0,
          }}
        >
          {JSON.stringify(result.output, null, 2)}
        </pre>
        <TraceSection result={result} />
      </div>
    );
  }

  return (
    <div>
      <div style={{ color: "#dc2626", fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
        EXECUTION ERROR — {result.duration_ms.toFixed(1)} ms
      </div>
      <div style={{ fontSize: 13, marginBottom: 8 }}>
        <strong>{result.error_type}</strong>: {result.error_message}
      </div>
      {result.traceback && (
        <pre
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 8,
            padding: 12,
            fontSize: 12,
            overflowX: "auto",
            margin: 0,
            color: "#7f1d1d",
          }}
        >
          {result.traceback}
        </pre>
      )}
      <TraceSection result={result} />
    </div>
  );
}

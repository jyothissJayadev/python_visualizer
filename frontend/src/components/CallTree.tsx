import { useState } from "react";
import type { TraceCall } from "../types";

function ValueBlock({ label, value, tone }: { label: string; value: unknown; tone: "in" | "out" | "err" }) {
  const colors = {
    in: { border: "#e2e8f0", bg: "#f8fafc", label: "#64748b" },
    out: { border: "#bbf7d0", bg: "#f0fdf4", label: "#15803d" },
    err: { border: "#fecaca", bg: "#fef2f2", label: "#b91c1c" },
  }[tone];
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: colors.label, letterSpacing: 0.4 }}>{label}</div>
      <pre
        style={{
          margin: "2px 0 0 0",
          padding: "6px 8px",
          background: colors.bg,
          border: `1px solid ${colors.border}`,
          borderRadius: 6,
          fontSize: 12,
          overflowX: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {text}
      </pre>
    </div>
  );
}

function CallNode({ call, filter }: { call: TraceCall; filter: string }) {
  const [open, setOpen] = useState(call.depth < 2);
  const hasChildren = call.children.length > 0 || call.children_truncated;

  const matches = (c: TraceCall): boolean =>
    !filter ||
    c.qualname.toLowerCase().includes(filter.toLowerCase()) ||
    c.children.some(matches);
  if (!matches(call)) return null;

  const argEntries = Object.entries(call.args);

  return (
    <div style={{ borderLeft: "2px solid #ede9fe", paddingLeft: 10, marginLeft: 2 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "3px 0" }}>
        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            border: "none",
            background: "transparent",
            cursor: hasChildren ? "pointer" : "default",
            color: "#9ca3af",
            width: 14,
            fontSize: 11,
            padding: 0,
          }}
        >
          {hasChildren ? (open ? "▼" : "▶") : "·"}
        </button>
        <span style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 600, color: "#1e293b" }}>
          {call.qualname}
        </span>
        <span style={{ fontSize: 11, color: "#94a3b8" }}>
          {call.file}:{call.line} · {call.duration_ms.toFixed(1)} ms
        </span>
        {call.exception && (
          <span style={{ fontSize: 11, color: "#b91c1c", fontWeight: 700 }}>✕ raised</span>
        )}
        {!call.returned && !call.exception && (
          <span style={{ fontSize: 11, color: "#b45309" }}>unfinished</span>
        )}
      </div>

      <div style={{ paddingLeft: 22 }}>
        {argEntries.length > 0 ? (
          <ValueBlock
            label="ARGS"
            tone="in"
            value={Object.fromEntries(argEntries)}
          />
        ) : (
          <div style={{ fontSize: 11, color: "#cbd5e1", marginTop: 2 }}>no args</div>
        )}
        {call.exception ? (
          <ValueBlock label="RAISED" tone="err" value={call.exception} />
        ) : call.returned ? (
          <ValueBlock label="RETURN" tone="out" value={call.return_value} />
        ) : null}
      </div>

      {open && hasChildren && (
        <div style={{ marginTop: 2 }}>
          {call.children.map((child) => (
            <CallNode key={child.call_id} call={child} filter={filter} />
          ))}
          {call.children_truncated && (
            <div style={{ fontSize: 11, color: "#b45309", paddingLeft: 12 }}>
              … deeper calls dropped (depth / call cap)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function CallTree({ roots, filter }: { roots: TraceCall[]; filter: string }) {
  if (roots.length === 0) {
    return <div style={{ color: "#9ca3af", fontSize: 13 }}>No calls under the trace root were recorded.</div>;
  }
  return (
    <div>
      {roots.map((root) => (
        <CallNode key={root.call_id} call={root} filter={filter} />
      ))}
    </div>
  );
}

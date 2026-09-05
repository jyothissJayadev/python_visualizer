import { useEffect, useState } from "react";
import type { FunctionDetail } from "../types";

function defaultToJsonValue(def: string | null): unknown {
  if (def === null) return null;
  const trimmed = def.trim();
  if (trimmed === "None") return null;
  if (trimmed === "True") return true;
  if (trimmed === "False") return false;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  try {
    return JSON.parse(trimmed.replace(/'/g, '"'));
  } catch {
    /* fall through */
  }
  return trimmed;
}

function buildDefaultArguments(fn: FunctionDetail): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const param of fn.parameters) {
    if (param.kind === "var_positional" || param.kind === "var_keyword") continue;
    args[param.name] = param.default !== null ? defaultToJsonValue(param.default) : null;
  }
  return args;
}

export function RunPanel({
  fn,
  onExecute,
  running,
}: {
  fn: FunctionDetail;
  onExecute: (args: Record<string, unknown>, trace: boolean) => void;
  running: boolean;
}) {
  const [text, setText] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [trace, setTrace] = useState(false);

  useEffect(() => {
    setText(JSON.stringify(buildDefaultArguments(fn), null, 2));
    setParseError(null);
  }, [fn.function_id]);

  const handleRun = () => {
    try {
      const parsed = JSON.parse(text);
      setParseError(null);
      onExecute(parsed, trace);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>
        INPUT — one JSON value per parameter: {fn.parameters.map((p) => p.name).join(", ") || "(no parameters)"}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        style={{
          width: "100%",
          fontFamily: "monospace",
          fontSize: 13,
          padding: 8,
          border: "1px solid #d1d5db",
          borderRadius: 6,
          boxSizing: "border-box",
        }}
      />
      {parseError && <div style={{ color: "#dc2626", fontSize: 12, marginTop: 4 }}>Invalid JSON: {parseError}</div>}
      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 12 }}>
        <button
          onClick={handleRun}
          disabled={running}
          style={{
            padding: "8px 20px",
            background: running ? "#9ca3af" : "#4f46e5",
            color: "white",
            border: "none",
            borderRadius: 6,
            fontWeight: 600,
            cursor: running ? "default" : "pointer",
          }}
        >
          {running ? "Running..." : "RUN FUNCTION"}
        </button>
        <label style={{ fontSize: 12, color: "#374151", display: "flex", alignItems: "center", gap: 5 }}>
          <input type="checkbox" checked={trace} onChange={(e) => setTrace(e.target.checked)} />
          trace nested calls
        </label>
      </div>
    </div>
  );
}

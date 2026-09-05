import { useEffect, useState } from "react";
import { api } from "../api/client";
import { FunctionTree } from "../components/FunctionTree";
import { ParameterList } from "../components/ParameterList";
import { ResultPanel } from "../components/ResultPanel";
import { RunPanel } from "../components/RunPanel";
import { SourceView } from "../components/SourceView";
import type { ExecutionResult, FunctionDetail, FunctionInfo, ScanResult } from "../types";

export function ExplorerPage() {
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [functions, setFunctions] = useState<FunctionInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FunctionDetail | null>(null);
  const [result, setResult] = useState<ExecutionResult | null>(null);
  const [running, setRunning] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);

  const load = async () => {
    try {
      const [projectData, functionData] = await Promise.all([api.getProject(), api.listFunctions()]);
      setScan(projectData);
      setFunctions(functionData);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    setResult(null);
    api
      .getFunction(selectedId)
      .then(setDetail)
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, [selectedId]);

  const handleRescan = async () => {
    setRescanning(true);
    try {
      await load();
    } finally {
      setRescanning(false);
    }
  };

  const handleExecute = async (args: Record<string, unknown>, trace: boolean) => {
    if (!detail) return;
    setRunning(true);
    setResult(null);
    try {
      const executionResult = await api.executeFunction(detail.function_id, args, trace);
      setResult(executionResult);
    } catch (err) {
      setResult({
        success: false,
        output: null,
        error_type: "NetworkError",
        error_message: err instanceof Error ? err.message : String(err),
        traceback: null,
        duration_ms: 0,
        trace: null,
        trace_id: null,
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <header
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div>
          <strong>Python Backend Explorer</strong>
          {scan && <span style={{ marginLeft: 12, color: "#6b7280", fontSize: 13 }}>{scan.project_path}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {scan && (
            <span style={{ fontSize: 12, color: "#6b7280" }}>
              {functions.length} functions · {scan.scanned_file_count} files scanned
              {scan.errors.length > 0 ? ` · ${scan.errors.length} scan error(s)` : ""}
            </span>
          )}
          <button
            onClick={handleRescan}
            disabled={rescanning}
            style={{
              padding: "6px 14px",
              border: "1px solid #d1d5db",
              borderRadius: 6,
              background: "white",
              cursor: rescanning ? "default" : "pointer",
              fontSize: 13,
            }}
          >
            {rescanning ? "Rescanning..." : "RESCAN PROJECT"}
          </button>
        </div>
      </header>

      {loadError && (
        <div style={{ padding: "8px 16px", background: "#fef2f2", color: "#7f1d1d", fontSize: 13 }}>
          Could not reach explorer backend at http://127.0.0.1:8765 — is it running? ({loadError})
        </div>
      )}

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <aside style={{ width: 320, borderRight: "1px solid #e5e7eb", padding: 12, overflowY: "auto" }}>
          <FunctionTree functions={functions} selectedId={selectedId} onSelect={setSelectedId} />
        </aside>

        <main style={{ flex: 1, padding: 16, overflowY: "auto" }}>
          {!detail && <div style={{ color: "#9ca3af" }}>Select a function from the tree to inspect it.</div>}

          {detail && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 900 }}>
              <div>
                <h2 style={{ margin: "0 0 4px 0", fontFamily: "monospace" }}>
                  {detail.class_name ? `${detail.class_name}.${detail.name}` : detail.name}
                  {detail.is_async && (
                    <span
                      style={{
                        marginLeft: 10,
                        fontSize: 11,
                        fontWeight: 600,
                        color: "#7c3aed",
                        background: "#ede9fe",
                        padding: "2px 8px",
                        borderRadius: 10,
                        verticalAlign: "middle",
                      }}
                    >
                      ASYNC FUNCTION
                    </span>
                  )}
                </h2>
                <div style={{ fontSize: 13, color: "#6b7280" }}>
                  {detail.file_path}:{detail.line_number} — {detail.qualified_name}
                </div>
                {detail.decorators.length > 0 && (
                  <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4, fontFamily: "monospace" }}>
                    {detail.decorators.map((d) => `@${d}`).join("  ")}
                  </div>
                )}
                {detail.docstring && (
                  <p style={{ fontSize: 13, color: "#374151", marginTop: 8, whiteSpace: "pre-wrap" }}>
                    {detail.docstring}
                  </p>
                )}
              </div>

              <div>
                <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>
                  PARAMETERS{detail.return_annotation ? ` → returns ${detail.return_annotation}` : ""}
                </div>
                <ParameterList parameters={detail.parameters} />
              </div>

              <div>
                <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>SOURCE</div>
                <SourceView source={detail.source} startLine={detail.line_number} />
              </div>

              <div>
                <RunPanel fn={detail} onExecute={handleExecute} running={running} />
              </div>
            </div>
          )}
        </main>
      </div>

      <footer style={{ borderTop: "1px solid #e5e7eb", padding: 16, minHeight: 120, maxHeight: 320, overflowY: "auto" }}>
        <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>EXECUTION RESULT</div>
        <ResultPanel result={result} />
      </footer>
    </div>
  );
}

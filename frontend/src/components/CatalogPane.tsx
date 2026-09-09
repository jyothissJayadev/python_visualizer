import { useEffect, useMemo, useRef, useState } from "react";
import { store } from "../lib/store";
import { useTerminal } from "../lib/useTerminal";

const DOMAINS = ["quotation", "execution", "quotation_edit", "extraction"];

interface Props {
  collapsed: boolean;
  onOpenModal: () => void;
  testDrawerOpen: boolean;
  setTestDrawerOpen: (v: boolean) => void;
}

export function CatalogPane({
  collapsed,
  onOpenModal,
  testDrawerOpen,
  setTestDrawerOpen,
}: Props) {
  const s = useTerminal();
  const messageRef = useRef<HTMLTextAreaElement>(null);

  const [domain, setDomain] = useState("quotation");
  const [sessionId, setSessionId] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (testDrawerOpen) messageRef.current?.focus();
  }, [testDrawerOpen]);

  const deepCount = useMemo(
    () =>
      Array.from(s.selectedFunctions).filter(
        (id) => s.functionModes.get(id) === "deep",
      ).length,
    [s.selectedFunctions, s.functionModes],
  );

  const selectedRows = useMemo(() => {
    return Array.from(s.selectedFunctions)
      .map((id) => {
        const meta = s.fnById.get(id);
        return {
          id,
          name: meta ? meta.name : id.split(":").pop()!,
          pkg: meta ? meta.package : id.split(":")[0],
          missing: !meta && s.catalog.groups.length > 0,
        };
      })
      .sort((a, b) => (a.pkg + a.name).localeCompare(b.pkg + b.name));
  }, [s.selectedFunctions, s.fnById, s.catalog]);

  const applyLabel = s.selectionDirty
    ? `Apply selection (${s.selectedFunctions.size})`
    : `Applied — ${s.appliedSelection.size} armed`;

  return (
    <aside className={"catalog-pane" + (collapsed ? " collapsed" : "")}>
      <div className="catalog-header">
        <div className="catalog-title-row">
          <span className="catalog-title">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20 6 9 17l-5-5" />
            </svg>
            Traced Functions
          </span>
          <span className="badge badge-dim">{s.selectedFunctions.size}</span>
        </div>
        <button
          className="btn-primary btn-sm"
          style={{ justifyContent: "center", width: "100%" }}
          onClick={onOpenModal}
        >
          + Add / manage functions
        </button>
      </div>

      <div className="test-request-section">
        <button
          className="test-request-toggle"
          onClick={() => setTestDrawerOpen(!testDrawerOpen)}
        >
          <span>⚡ Send Test Request</span>
          <span>{testDrawerOpen ? "▴" : "▾"}</span>
        </button>
        <div className={"test-request-body" + (testDrawerOpen ? "" : " hidden")}>
          <div className="form-group">
            <label>Domain</label>
            <select value={domain} onChange={(e) => setDomain(e.target.value)}>
              {DOMAINS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Session ID (optional)</label>
            <input
              type="text"
              placeholder="e.g. sess_abc123"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>Message / Prompt</label>
            <textarea
              ref={messageRef}
              placeholder="Type input payload or prompt..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
          <button
            className="btn-primary"
            style={{ marginTop: 4, justifyContent: "center" }}
            onClick={() =>
              store.runTest(
                domain,
                message.trim() || "Process sample quotation payload",
                sessionId.trim() || null,
              )
            }
          >
            Run Test Pipeline
          </button>
        </div>
      </div>

      {s.codeInSync === false && (
        <div className="code-sync-banner">
          <span>
            ⚠ brain is running different code than the last scan (
            {s.brainFingerprint || ""})
          </span>
          <button className="btn-sm" onClick={() => store.rescanCatalog()}>
            Rescan
          </button>
        </div>
      )}

      <div className="catalog-tree-container">
        {selectedRows.length === 0 ? (
          <div className="selected-empty">
            No functions selected.
            <br />
            Click <b>+ Add / manage functions</b> to pick which functions to
            trace.
          </div>
        ) : (
          selectedRows.map((r) => {
            const isDeep = s.functionModes.get(r.id) === "deep";
            const isErr = r.missing || s.unresolvedIds.has(r.id);
            return (
              <div
                key={r.id}
                className={"selected-fn-row" + (isErr ? " armed-error" : "")}
                title={
                  r.id +
                  (isErr
                    ? "\n(not found in the current scan — Rescan or remove)"
                    : "")
                }
              >
                <div className="selected-fn-main">
                  <span className="selected-fn-name">{r.name}</span>
                  <span className="selected-fn-pkg">{r.pkg}</span>
                </div>
                <button
                  className={"fn-deep-toggle" + (isDeep ? " on" : "")}
                  title="Shallow = just this call. Deep = every nested call under app/ while it runs."
                  onClick={() => store.setDeep(r.id, !isDeep)}
                >
                  {isDeep ? "DEEP" : "↳"}
                </button>
                <button
                  className="selected-fn-remove"
                  title="Remove"
                  onClick={() => store.toggleFn(r.id, false)}
                >
                  ✕
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="catalog-footer">
        <div
          style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%" }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span className="catalog-stat">
              {s.selectedFunctions.size} selected · {deepCount} deep
            </span>
            <button className="btn-sm" onClick={() => store.clearSelection()}>
              Clear
            </button>
          </div>
          <button
            className={"btn-primary btn-sm" + (s.selectionDirty ? " dirty" : "")}
            style={{ justifyContent: "center" }}
            disabled={s.selectedFunctions.size === 0 && s.appliedSelection.size === 0}
            onClick={() => store.applySelection()}
          >
            {applyLabel}
          </button>
        </div>
      </div>
    </aside>
  );
}

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
          isAsync: meta ? meta.is_async : false,
          missing: !meta && s.catalog.groups.length > 0,
        };
      })
      .sort((a, b) => (a.pkg + a.name).localeCompare(b.pkg + b.name));
  }, [s.selectedFunctions, s.fnById, s.catalog]);

  const groupedSelected = useMemo(() => {
    const map = new Map<string, typeof selectedRows>();
    for (const r of selectedRows) {
      const list = map.get(r.pkg) || [];
      list.push(r);
      map.set(r.pkg, list);
    }
    return Array.from(map.entries()).map(([pkg, fns]) => ({ pkg, fns }));
  }, [selectedRows]);

  const selectionSig = useMemo(
    () =>
      Array.from(s.selectedFunctions).sort().join("|") +
      "::" +
      Array.from(s.functionModes.keys()).sort().join("|"),
    [s.selectedFunctions, s.functionModes],
  );

  const applyLabel = s.selectionDirty
    ? `⚡ Apply Changes (${s.selectedFunctions.size})`
    : `Armed (${s.appliedSelection.size} Active)`;

  const dirtyReason = (() => {
    if (!s.selectionDirty) return null;
    const armedNow = s.appliedSelection.size;
    const pick = s.selectedFunctions.size;
    if (pick > armedNow) return `${pick - armedNow} added — pending apply`;
    if (pick < armedNow) return `${armedNow - pick} removed — pending apply`;
    return "Depth mode modified — pending apply";
  })();

  return (
    <aside className={"catalog-pane" + (collapsed ? " collapsed" : "")}>
      <div className="catalog-header">
        <div className="catalog-title-row">
          <span className="catalog-title">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M20 6 9 17l-5-5" />
            </svg>
            Traced Functions
          </span>
          <span className="badge badge-dim">{s.selectedFunctions.size}</span>
        </div>
        <button
          className="btn-primary btn-sm"
          style={{ justifyContent: "center", width: "100%", padding: "6px 10px" }}
          onClick={onOpenModal}
        >
          + Add / Manage Functions
        </button>
      </div>

      <div className="test-request-section">
        <button
          className="test-request-toggle"
          onClick={() => setTestDrawerOpen(!testDrawerOpen)}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span>⚡</span>
            <span>Send Test Request</span>
          </span>
          <span style={{ fontSize: 10 }}>{testDrawerOpen ? "▲" : "▼"}</span>
        </button>
        <div className={"test-request-body" + (testDrawerOpen ? "" : " hidden")}>
          <div className="form-group">
            <label>Domain Target</label>
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
              placeholder="e.g. sess_live_123"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>Message / Prompt Payload</label>
            <textarea
              ref={messageRef}
              placeholder="Enter test prompt or input payload..."
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
            🚀 Execute Test Pipeline
          </button>
        </div>
      </div>

      {s.codeInSync === false && (
        <div className="code-sync-banner">
          <span>
            ⚠ Brain code differs from last scan
          </span>
          <button className="btn-sm" onClick={() => store.rescanCatalog()}>
            Rescan
          </button>
        </div>
      )}

      <div className="catalog-tree-container">
        {selectedRows.length === 0 ? (
          <div className="selected-empty">
            <div style={{ fontSize: 24, marginBottom: 8, opacity: 0.8 }}>⚡</div>
            <b>No Functions Armed</b>
            <div style={{ marginTop: 4, color: "var(--text-muted)", fontSize: 11.5 }}>
              Click <b>+ Add / Manage Functions</b> above to select which backend functions to trace.
            </div>
          </div>
        ) : (
          groupedSelected.map((group) => (
            <div key={group.pkg} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <div className="selected-pkg-divider">
                <span className="selected-pkg-label">{group.pkg}</span>
                <div className="selected-pkg-line" />
                <span className="badge badge-dim" style={{ fontSize: 9.5 }}>{group.fns.length}</span>
              </div>

              {group.fns.map((r) => {
                const isDeep = s.functionModes.get(r.id) === "deep";
                const isErr = r.missing || s.unresolvedIds.has(r.id);
                return (
                  <div
                    key={r.id}
                    className={
                      "selected-fn-row" +
                      (isDeep ? " deep-mode" : "") +
                      (isErr ? " armed-error" : "")
                    }
                    title={
                      r.id +
                      (isErr
                        ? "\n(not found in the current scan — Rescan or remove)"
                        : "")
                    }
                  >
                    <div className="selected-fn-main">
                      <div className="selected-fn-name-row">
                        <span className="selected-fn-name">{r.name}</span>
                        {r.isAsync && (
                          <span className="badge badge-async" style={{ fontSize: 8.5, padding: "0 4px" }}>
                            async
                          </span>
                        )}
                      </div>
                      <span className="selected-fn-pkg">{r.pkg}</span>
                    </div>

                    <button
                      className={"fn-deep-toggle" + (isDeep ? " on" : "")}
                      title={
                        isDeep
                          ? "Deep mode ON: traces every nested call underneath this function"
                          : "Shallow mode: traces only top-level call (click to enable Deep mode)"
                      }
                      onClick={() => store.setDeep(r.id, !isDeep)}
                    >
                      {isDeep ? "⚡ DEEP" : "↳ TOP"}
                    </button>

                    <button
                      className="selected-fn-remove"
                      title="Remove from trace selection"
                      onClick={() => store.toggleFn(r.id, false)}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      <div className="catalog-footer">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span className="catalog-stat">
            <b>{s.selectedFunctions.size}</b> selected · <b>{deepCount}</b> deep
          </span>
          {s.selectedFunctions.size > 0 && (
            <button className="btn-sm" onClick={() => store.clearSelection()}>
              Clear all
            </button>
          )}
        </div>

        {dirtyReason && (
          <span className="apply-dirty-hint">{dirtyReason}</span>
        )}

        <button
          key={s.selectionDirty ? "dirty:" + selectionSig : "clean"}
          className={
            "btn-primary btn-sm apply-selection-btn" +
            (s.selectionDirty ? " dirty" : "")
          }
          style={{ justifyContent: "center", width: "100%", padding: "7px 10px" }}
          disabled={s.selectedFunctions.size === 0 && s.appliedSelection.size === 0}
          onClick={() => store.applySelection()}
        >
          {applyLabel}
        </button>
      </div>
    </aside>
  );
}


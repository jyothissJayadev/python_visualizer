import { useMemo, useState } from "react";
import { store } from "../lib/store";
import { useTerminal } from "../lib/useTerminal";
import type { Template } from "../types";

interface Props {
  collapsed: boolean;
  onOpenModal: () => void;
  onEditTemplate: (template: Template) => void;
}

export function CatalogPane({
  collapsed,
  onOpenModal,
  onEditTemplate,
}: Props) {
  const s = useTerminal();
  const [savingName, setSavingName] = useState("");
  const [showSaveInput, setShowSaveInput] = useState(false);

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

      <div className="catalog-header" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        <div className="catalog-title-row">
          <span className="catalog-title">📋 Trace Templates</span>
          <span className="badge badge-dim">{s.templates.length}</span>
        </div>

        {s.templates.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: showSaveInput ? 8 : 0 }}>
            {s.templates.map((t) => {
              const missingCount = t.functions.filter((f) => f.status === "missing").length;
              return (
                <div
                  key={t.id}
                  className="selected-fn-row"
                  style={{ cursor: "pointer" }}
                  title={`Apply "${t.name}" (${t.functions.length} functions)`}
                >
                  <div className="selected-fn-main" onClick={() => store.applyTemplate(t.id)}>
                    <div className="selected-fn-name-row">
                      <span className="selected-fn-name">{t.name}</span>
                      {missingCount > 0 && (
                        <span className="badge" style={{ fontSize: 8.5, padding: "0 4px", color: "var(--accent-red, #ff6b6b)" }}>
                          {missingCount} missing
                        </span>
                      )}
                    </div>
                    <span className="selected-fn-pkg">{t.functions.length} function(s)</span>
                  </div>
                  <button className="btn-sm" style={{ fontSize: 10.5, padding: "2px 6px" }} onClick={() => onEditTemplate(t)}>
                    ✎ Edit
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {showSaveInput ? (
          <div style={{ display: "flex", gap: 6 }}>
            <input
              autoFocus
              type="text"
              placeholder="Template name…"
              value={savingName}
              onChange={(e) => setSavingName(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === "Enter" && savingName.trim()) {
                  const ok = await store.saveTemplate(savingName.trim());
                  if (ok) {
                    setSavingName("");
                    setShowSaveInput(false);
                  }
                } else if (e.key === "Escape") {
                  setShowSaveInput(false);
                }
              }}
              style={{
                flex: 1,
                background: "transparent",
                border: "1px solid var(--border-subtle)",
                borderRadius: 4,
                padding: "4px 8px",
                color: "inherit",
                fontSize: 11.5,
              }}
            />
            <button
              className="btn-primary btn-sm"
              disabled={!savingName.trim()}
              onClick={async () => {
                const ok = await store.saveTemplate(savingName.trim());
                if (ok) {
                  setSavingName("");
                  setShowSaveInput(false);
                }
              }}
            >
              Save
            </button>
            <button className="btn-sm" onClick={() => setShowSaveInput(false)}>
              ✕
            </button>
          </div>
        ) : (
          <button
            className="btn-sm"
            style={{ justifyContent: "center", width: "100%" }}
            disabled={s.selectedFunctions.size === 0}
            title={
              s.selectedFunctions.size === 0
                ? "Select functions above first"
                : "Save the current selection as a reusable template"
            }
            onClick={() => setShowSaveInput(true)}
          >
            + Save current selection as template
          </button>
        )}
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


import { useMemo, useState } from "react";
import { store } from "../lib/store";
import { useTerminal } from "../lib/useTerminal";
import type { Template, TemplateFunction } from "../types";

interface Props {
  template: Template | null; // null closes the modal
  onClose: () => void;
}

/** Editing a saved template never touches the live armed selection — unlike
    CatalogModal (whose Add/Deep buttons call store.toggleFn/setDeep directly
    against what's actually armed), this holds its own local draft and only
    persists on Save via store.updateTemplate. See docs/designs/trace-templates.md. */
export function TemplateEditModal({ template, onClose }: Props) {
  if (!template) return null;
  // key={template.id} below forces a fresh instance (and fresh initial state)
  // whenever a different template opens — no effect needed to re-seed the draft.
  return <TemplateEditModalInner key={template.id} template={template} onClose={onClose} />;
}

function TemplateEditModalInner({ template, onClose }: { template: Template; onClose: () => void }) {
  const s = useTerminal();
  const [name, setName] = useState(template.name);
  const [draft, setDraft] = useState<TemplateFunction[]>(() => template.functions.map((f) => ({ ...f })));
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);

  const draftIds = useMemo(() => new Set(draft.map((f) => f.id)), [draft]);

  const pickerGroups = useMemo(() => {
    const q = search.toLowerCase().trim();
    return s.catalog.groups
      .map((group) => {
        const addable = group.functions.filter((f) => !draftIds.has(f.id));
        const filtered = q
          ? addable.filter(
              (f) => f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q),
            )
          : addable;
        return { package: group.package, functions: filtered };
      })
      .filter((g) => g.functions.length > 0);
  }, [s.catalog, draftIds, search]);

  const addToDraft = (id: string, deep: boolean) => {
    setDraft((prev) => [...prev, { id, deep, status: "ok", suggestions: [] }]);
  };

  const removeFromDraft = (id: string) => {
    setDraft((prev) => prev.filter((f) => f.id !== id));
  };

  const toggleDeep = (id: string) => {
    setDraft((prev) => prev.map((f) => (f.id === id ? { ...f, deep: !f.deep } : f)));
  };

  const acceptSuggestion = (id: string, suggestion: string) => {
    setDraft((prev) =>
      prev.map((f) =>
        f.id === id ? { id: suggestion, deep: f.deep, status: "ok", suggestions: [] } : f,
      ),
    );
  };

  const save = async () => {
    if (!name.trim() || draft.length === 0) return;
    setSaving(true);
    const ok = await store.updateTemplate(template.id, {
      name,
      functions: draft.map((f) => ({ id: f.id, deep: f.deep })),
    });
    setSaving(false);
    if (ok) onClose();
  };

  const remove = async () => {
    if (!confirm(`Delete template "${template.name}"? This can't be undone.`)) return;
    await store.deleteTemplate(template.id);
    onClose();
  };

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-card catalog-modal-card">
        <div className="modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
            <span style={{ fontSize: 16 }}>📋</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Template name"
              style={{
                fontSize: 13.5,
                fontWeight: 700,
                background: "transparent",
                border: "1px solid var(--border-subtle)",
                borderRadius: 4,
                padding: "3px 8px",
                color: "inherit",
                flex: 1,
                maxWidth: 260,
              }}
            />
            <span className="badge badge-dim">{draft.length} functions</span>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="btn-sm" style={{ color: "var(--accent-red, #ff6b6b)" }} onClick={remove}>
              🗑 Delete
            </button>
            <button className="btn-sm btn-icon" onClick={onClose} title="Close">
              ✕
            </button>
          </div>
        </div>

        <div className="catalog-modal-scroll-area">
          <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 5 }}>
            {draft.length === 0 ? (
              <div className="selected-empty" style={{ margin: "10px auto" }}>
                No functions in this template yet — add some below.
              </div>
            ) : (
              draft.map((f) => {
                const meta = s.fnById.get(f.id);
                const isMissing = f.status === "missing";
                return (
                  <div
                    key={f.id}
                    className={"selected-fn-row" + (f.deep ? " deep-mode" : "") + (isMissing ? " armed-error" : "")}
                    title={f.id + (isMissing ? "\n(not found in the current scan)" : "")}
                  >
                    <div className="selected-fn-main">
                      <div className="selected-fn-name-row">
                        <span className="selected-fn-name">{meta ? meta.name : f.id.split(":").pop()}</span>
                      </div>
                      <span className="selected-fn-pkg">{meta ? meta.package : f.id.split(":")[0]}</span>
                      {isMissing && f.suggestions && f.suggestions.length > 0 && (
                        <div style={{ marginTop: 3, fontSize: 10.5 }}>
                          Rename to{" "}
                          {f.suggestions.map((sug) => (
                            <button
                              key={sug}
                              className="btn-sm"
                              style={{ fontSize: 10, padding: "1px 5px", marginRight: 4 }}
                              onClick={() => acceptSuggestion(f.id, sug)}
                            >
                              {sug.split(":").pop()}?
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      className={"fn-deep-toggle" + (f.deep ? " on" : "")}
                      onClick={() => toggleDeep(f.id)}
                    >
                      {f.deep ? "⚡ DEEP" : "↳ TOP"}
                    </button>
                    <button className="selected-fn-remove" onClick={() => removeFromDraft(f.id)}>
                      ✕
                    </button>
                  </div>
                );
              })
            )}
          </div>

          <div
            style={{
              padding: "10px 14px",
              borderTop: "1px solid var(--border-subtle)",
              borderBottom: "1px solid var(--border-subtle)",
            }}
          >
            <div className="catalog-search-wrap">
              <input
                type="text"
                placeholder="Add functions to this template…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          {pickerGroups.map((group) => (
            <div key={group.package} className="catalog-pkg-card">
              <div className="pkg-header-banner">
                <div className="pkg-header-left">
                  <span className="badge badge-pkg">{group.package}</span>
                </div>
              </div>
              <div className="pkg-functions-grid">
                {group.functions.map((fn) => (
                  <div key={fn.id} className="fn-picker-item" title={fn.id}>
                    <div className="fn-picker-item-left">
                      <div className="fn-picker-name-row">
                        <span className="fn-picker-icon">fn</span>
                        <span className="fn-picker-name">{fn.name}</span>
                      </div>
                    </div>
                    <div className="fn-picker-actions">
                      <button className="fn-picker-btn-deep" onClick={() => addToDraft(fn.id, true)}>
                        ⚡ + Deep
                      </button>
                      <button className="fn-picker-btn-add" onClick={() => addToDraft(fn.id, false)}>
                        + Add
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="modal-footer">
          <div />
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button className="btn-sm" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn-primary btn-sm"
              disabled={saving || !name.trim() || draft.length === 0}
              onClick={save}
            >
              {saving ? "Saving…" : "Save Template"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

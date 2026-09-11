import { useEffect, useMemo, useRef } from "react";
import { store } from "../lib/store";
import { useTerminal } from "../lib/useTerminal";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function CatalogModal({ open, onClose }: Props) {
  const s = useTerminal();
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      store.setCatalogSearch("");
      const t = setTimeout(() => searchRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  const search = s.catalogSearchQuery.toLowerCase().trim();

  const groups = useMemo(() => {
    return s.catalog.groups
      .map((group) => {
        const addable = group.functions.filter(
          (f) => !s.selectedFunctions.has(f.id),
        );
        const filtered = search
          ? addable.filter(
              (f) =>
                f.name.toLowerCase().includes(search) ||
                f.id.toLowerCase().includes(search) ||
                group.package.toLowerCase().includes(search) ||
                (f.doc && f.doc.toLowerCase().includes(search)),
            )
          : addable;
        return { package: group.package, functions: filtered };
      })
      .filter((g) => g.functions.length > 0);
  }, [s.catalog, s.selectedFunctions, search]);

  const totalInCatalogue = useMemo(
    () => s.catalog.groups.reduce((n, g) => n + g.functions.length, 0),
    [s.catalog],
  );

  const totalMatching = useMemo(
    () => groups.reduce((n, g) => n + g.functions.length, 0),
    [groups],
  );

  const add = (id: string, deep: boolean) => {
    store.toggleFn(id, true);
    if (deep) store.setDeep(id, true);
  };

  const addAllInGroup = (functions: { id: string }[], deep: boolean) => {
    functions.forEach((fn) => {
      store.toggleFn(fn.id, true);
      if (deep) store.setDeep(fn.id, true);
    });
  };

  return (
    <div
      className={"modal-overlay" + (open ? "" : " hidden")}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-card catalog-modal-card">
        <div className="modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>📦</span>
            <span style={{ fontSize: 13.5, fontWeight: 700 }}>Select Functions to Trace</span>
            <span className="badge badge-dim">{totalMatching} available</span>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              className="btn-sm"
              title="Re-parse brain source code"
              onClick={() => store.rescanCatalog()}
            >
              🔄 Rescan
            </button>
            <button className="btn-sm btn-icon" onClick={onClose} title="Close">
              ✕
            </button>
          </div>
        </div>

        <div
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid var(--border-subtle)",
            background: "rgba(10, 15, 28, 0.5)",
          }}
        >
          <div className="catalog-search-wrap">
            <svg
              className="search-icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              ref={searchRef}
              type="text"
              placeholder="Search functions by name, package, or docstring..."
              value={s.catalogSearchQuery}
              onChange={(e) => store.setCatalogSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="catalog-modal-scroll-area">
          {groups.length === 0 ? (
            <div className="selected-empty" style={{ margin: "20px auto", maxWidth: 460 }}>
              {search ? (
                <>
                  🔍 <b>No unselected functions match "{search}".</b>
                  <br />
                  Already-selected functions are managed in the sidebar rail.
                </>
              ) : (
                <>
                  ✅ <b>All functions are currently selected.</b>
                  <br />
                  You can manage active trace modes (Shallow / Deep) in the sidebar.
                </>
              )}
            </div>
          ) : (
            groups.map((group) => {
              const collapsed = search
                ? false
                : !s.collapsedPackages.has("OPEN:" + group.package);
              return (
                <div key={group.package} className="catalog-pkg-card">
                  <div
                    className="pkg-header-banner"
                    onClick={() => store.togglePackage(group.package)}
                  >
                    <div className="pkg-header-left">
                      <span
                        className={"pkg-toggle-arrow" + (collapsed ? "" : " expanded")}
                      >
                        ▶
                      </span>
                      <span className="badge badge-pkg">{group.package}</span>
                      <span className="badge badge-dim" style={{ fontSize: 10.5 }}>
                        {group.functions.length} {group.functions.length === 1 ? "fn" : "fns"}
                      </span>
                    </div>
                    <div
                      className="pkg-header-actions"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        className="btn-sm"
                        style={{ fontSize: 10.5, padding: "2px 6px" }}
                        title="Add all functions in this package (shallow)"
                        onClick={() => addAllInGroup(group.functions, false)}
                      >
                        + Add all
                      </button>
                      <button
                        className="btn-sm"
                        style={{ fontSize: 10.5, padding: "2px 6px", color: "var(--accent-cyan)" }}
                        title="Add all functions in this package as deep"
                        onClick={() => addAllInGroup(group.functions, true)}
                      >
                        + All deep
                      </button>
                    </div>
                  </div>

                  {!collapsed && (
                    <div className="pkg-functions-grid">
                      {group.functions.map((fn) => (
                        <div
                          key={fn.id}
                          className="fn-picker-item"
                          title={`${fn.id}\n${fn.signature || ""}\n${fn.doc || ""}`}
                        >
                          <div className="fn-picker-item-left">
                            <div className="fn-picker-name-row">
                              <span className="fn-picker-icon">fn</span>
                              <span className="fn-picker-name">{fn.name}</span>
                              {fn.is_async && (
                                <span className="badge badge-async">async</span>
                              )}
                              {fn.signature && (
                                <span className="fn-picker-sig">{fn.signature}</span>
                              )}
                            </div>
                            {fn.doc && (
                              <div className="fn-picker-doc" title={fn.doc}>
                                {fn.doc.split("\n")[0]}
                              </div>
                            )}
                          </div>

                          <div className="fn-picker-actions">
                            <button
                              className="fn-picker-btn-deep"
                              title="Trace this call and all nested calls under app/"
                              onClick={() => add(fn.id, true)}
                            >
                              ⚡ + Deep
                            </button>
                            <button
                              className="fn-picker-btn-add"
                              title="Trace only this top-level call"
                              onClick={() => add(fn.id, false)}
                            >
                              + Add
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="modal-footer">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="catalog-stat">
              <b>{s.selectedFunctions.size}</b> selected · <b>{totalInCatalogue}</b> in catalogue
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {s.selectionDirty && (
              <span className="apply-dirty-hint">
                Unapplied changes pending
              </span>
            )}
            <button
              className={
                "btn-primary btn-sm apply-selection-btn" +
                (s.selectionDirty ? " dirty" : "")
              }
              onClick={() => {
                if (s.selectionDirty) store.applySelection();
                onClose();
              }}
            >
              {s.selectionDirty ? "⚡ Apply & Close" : "Done"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


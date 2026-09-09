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
                group.package.toLowerCase().includes(search),
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

  const add = (id: string, deep: boolean) => {
    store.toggleFn(id, true);
    if (deep) store.setDeep(id, true);
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
          <span>Select functions to trace</span>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button
              className="btn-sm"
              title="Re-parse brain's source"
              onClick={() => store.rescanCatalog()}
            >
              Rescan
            </button>
            <button className="btn-sm btn-icon" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        <div
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          <div className="catalog-search-wrap">
            <svg className="search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              ref={searchRef}
              type="text"
              placeholder="Search functions…"
              value={s.catalogSearchQuery}
              onChange={(e) => store.setCatalogSearch(e.target.value)}
            />
          </div>
        </div>

        <div
          className="catalog-tree-container"
          style={{ flex: 1, maxHeight: "none" }}
        >
          {groups.length === 0 ? (
            <div className="selected-empty">
              {search ? (
                <>
                  No unselected functions match.
                  <br />
                  Already-selected ones are in the sidebar.
                </>
              ) : (
                <>Every function is already selected — manage them in the sidebar.</>
              )}
            </div>
          ) : (
            groups.map((group) => {
              const collapsed = search
                ? false
                : !s.collapsedPackages.has("OPEN:" + group.package);
              return (
                <div key={group.package} className="catalog-pkg-group">
                  <div
                    className="pkg-header-row"
                    onClick={() => store.togglePackage(group.package)}
                  >
                    <span
                      className={"pkg-toggle-arrow" + (collapsed ? "" : " expanded")}
                    >
                      ▶
                    </span>
                    <span className="pkg-name" title={group.package}>
                      {group.package}
                    </span>
                    <span className="pkg-count-badge">
                      {group.functions.length}
                    </span>
                  </div>
                  {!collapsed && (
                    <div className="pkg-children">
                      {group.functions.map((fn) => (
                        <div
                          key={fn.id}
                          className="fn-leaf-row"
                          title={`${fn.id}\n${fn.signature || ""}\n${fn.doc || ""}`}
                          onClick={() => add(fn.id, false)}
                        >
                          <span className="fn-leaf-name">
                            {fn.name}
                            {fn.is_async && (
                              <span style={{ color: "var(--accent-violet)" }}>
                                {" "}
                                async
                              </span>
                            )}
                          </span>
                          <button
                            className="fn-deep-toggle"
                            title="Add as deep — trace every nested call under app/"
                            onClick={(e) => {
                              e.stopPropagation();
                              add(fn.id, true);
                            }}
                          >
                            ＋ deep
                          </button>
                          <button
                            className="fn-deep-toggle on"
                            title="Add (shallow)"
                            onClick={(e) => {
                              e.stopPropagation();
                              add(fn.id, false);
                            }}
                          >
                            ＋ add
                          </button>
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
          <span className="catalog-stat">
            {s.selectedFunctions.size} selected · {totalInCatalogue} in catalogue
          </span>
          <button className="btn-primary btn-sm" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

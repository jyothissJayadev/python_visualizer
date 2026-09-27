import { useEffect, useState } from "react";
import { lineageStore } from "../../lib/lineageStore";
import { useLineage } from "../../lib/useLineage";
import { methodClass, pathParts } from "../../lib/lineageTree";
import type { LineageChainStatus } from "../../types";

const DEPTHS = [1, 2, 3, 4];

function LineageTreeSearchBox() {
  const { treeSearch, searchHits, searchIndex } = useLineage();
  const [query, setQuery] = useState(treeSearch);

  useEffect(() => {
    const t = setTimeout(() => lineageStore.setTreeSearch(query), 180);
    return () => clearTimeout(t);
  }, [query]);

  return (
    <div className="rt-search">
      <input
        className="rt-input"
        placeholder="Find function, route, component…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") lineageStore.stepSearch(e.shiftKey ? -1 : 1);
        }}
      />
      {treeSearch.trim().length >= 2 && (
        <span className="rt-search-count">
          {searchHits.length ? `${searchIndex + 1}/${searchHits.length}` : "0"}
          <button
            onClick={() => lineageStore.stepSearch(-1)}
            disabled={!searchHits.length}
            title="Previous match"
          >
            ↑
          </button>
          <button
            onClick={() => lineageStore.stepSearch(1)}
            disabled={!searchHits.length}
            title="Next match"
          >
            ↓
          </button>
        </span>
      )}
    </div>
  );
}

export function LineageHeader() {
  const { selectedChain, viewMode, drawerOpen } = useLineage();
  const chain = selectedChain;

  const statusLabels: Record<LineageChainStatus, { label: string; cls: string }> = {
    full_chain: { label: "Full Chain (to UI)", cls: "status-full" },
    client_api: { label: "Client API Ready", cls: "status-client" },
    backend_exposed: { label: "Backend Exposed", cls: "status-backend" },
    service_only: { label: "Service Only", cls: "status-service" },
    unexposed: { label: "Internal / Unexposed", cls: "status-unexposed" },
  };

  const statusInfo = chain ? statusLabels[chain.status] : null;

  return (
    <header className="lineage-header rt-header">
      <div className="rt-header-top">
        {chain ? (
          <>
            <span className={`rt-method big ${methodClass(chain.method)}`}>
              {chain.method}
            </span>
            <h2 className="rt-path big" title={chain.path}>
              {pathParts(chain.path).map((p, i) => (
                <span key={i} className={p.param ? "param" : ""}>
                  {p.text}
                </span>
              ))}
            </h2>
            {chain.endpoint.handler_name && (
              <span className="rt-handler" title={chain.endpoint.handler_id}>
                {chain.endpoint.handler_name}()
              </span>
            )}
            {statusInfo && (
              <span className={`chain-status-badge ${statusInfo.cls}`}>
                {statusInfo.label}
              </span>
            )}
          </>
        ) : (
          <h2 className="rt-path big muted">No endpoint selected</h2>
        )}

        <span className="rt-spacer" />

        {/* View Slider: Hierarchy Tree vs Graph View vs Swimlane Pipeline */}
        <div className="rt-seg" role="tablist" aria-label="Lineage View">
          <button
            role="tab"
            aria-selected={viewMode === "tree"}
            className={viewMode === "tree" ? "on" : ""}
            onClick={() => lineageStore.setViewMode("tree")}
            title="Collapsible multi-level call hierarchy tree"
          >
            Hierarchy Tree
          </button>
          <button
            role="tab"
            aria-selected={viewMode === "graph"}
            className={viewMode === "graph" ? "on" : ""}
            onClick={() => lineageStore.setViewMode("graph")}
            title="Interactive 2D left-to-right lineage graph"
          >
            Graph View
          </button>
          <button
            role="tab"
            aria-selected={viewMode === "swimlane"}
            className={viewMode === "swimlane" ? "on" : ""}
            onClick={() => lineageStore.setViewMode("swimlane")}
            title="Cross-layer 4-column swimlane pipeline"
          >
            Swimlane View
          </button>
        </div>

        {/* Code Inspector Drawer Toggle */}
        <button
          type="button"
          className={`rt-drawer-toggle ${drawerOpen ? "on" : ""}`}
          onClick={() => lineageStore.toggleDrawer()}
          title={drawerOpen ? "Close inspector panel (Esc)" : "Open inspector panel"}
          aria-label={drawerOpen ? "Close inspector panel" : "Open inspector panel"}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="15" y1="3" x2="15" y2="21" />
          </svg>
          <span>{drawerOpen ? "Hide Inspector" : "Inspector"}</span>
        </button>
      </div>

      {/* Secondary Toolbar (Tree/Graph Search + Expand/Collapse) */}
      {(viewMode === "tree" || viewMode === "graph") && chain && (
        <div className="rt-toolbar">
          <LineageTreeSearchBox key={chain.id} />

          <div className="rt-expand">
            <span className="rt-label">Expand to</span>
            {DEPTHS.map((d) => (
              <button
                key={d}
                className="rt-btn sm"
                onClick={() => lineageStore.expandTreeToLevel(d)}
                title={`Expand up to layer ${d}`}
              >
                L{d}
              </button>
            ))}
            <button
              className="rt-btn sm"
              onClick={() => lineageStore.expandAllTreeNodes()}
              title="Expand all nodes to leaf UI components"
            >
              All
            </button>
            <button
              className="rt-btn sm"
              onClick={() => lineageStore.collapseAllTreeNodes()}
              title="Collapse to root Brain endpoint"
            >
              Collapse
            </button>
          </div>

          <span className="rt-spacer" />

          {chain.stats && (
            <div className="rt-stats">
              <span className="rt-stat">
                <b>{chain.stats.services_count}</b> service{chain.stats.services_count === 1 ? "" : "s"}
              </span>
              <span className="rt-stat">
                <b>{chain.stats.routes_count}</b> route{chain.stats.routes_count === 1 ? "" : "s"}
              </span>
              <span className="rt-stat">
                <b>{chain.stats.client_apis_count}</b> client API{chain.stats.client_apis_count === 1 ? "" : "s"}
              </span>
              <span className="rt-stat">
                <b>{chain.stats.ui_usages_count}</b> UI caller{chain.stats.ui_usages_count === 1 ? "" : "s"}
              </span>
            </div>
          )}
        </div>
      )}
    </header>
  );
}

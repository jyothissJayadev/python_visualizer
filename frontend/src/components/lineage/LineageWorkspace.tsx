import { useEffect } from "react";
import { useLineage } from "../../lib/useLineage";
import { lineageStore } from "../../lib/lineageStore";
import { LineageSidebar } from "./LineageSidebar";
import { LineageHeader } from "./LineageHeader";
import { LineageHierarchyTree } from "./LineageHierarchyTree";
import { LineageGraphView } from "./LineageGraphView";
import { LineageSwimlane } from "./LineageSwimlane";
import { LineageDetailDrawer } from "./LineageDetailDrawer";
import "../../routes.css";

interface Props {
  active: boolean;
  urlChainId?: string;
  sidebarCollapsed?: boolean;
  onChainChange?: (id: string) => void;
}

export function LineageWorkspace({
  active,
  urlChainId,
  sidebarCollapsed = false,
  onChainChange,
}: Props) {
  const {
    loading,
    error,
    chains,
    summary,
    selectedChainId,
    selectedChain,
    selectedNodeDetail,
    viewMode,
    drawerOpen,
  } = useLineage();

  // Synchronize URL chain id with store
  useEffect(() => {
    if (active && urlChainId && urlChainId !== selectedChainId) {
      lineageStore.selectChain(urlChainId);
    }
  }, [active, urlChainId, selectedChainId]);

  // Handle Escape key to close drawer
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape" && lineageStore.getSnapshot().drawerOpen) {
        lineageStore.setDrawerOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);

  const handleSelectChain = (id: string) => {
    lineageStore.selectChain(id);
    onChainChange?.(id);
  };

  return (
    <div className="lineage-workspace">
      {/* Top Overview Metrics Strip */}
      <div className="lineage-summary-strip">
        <div className="summary-card stat-total">
          <span className="summary-count">{summary?.total_brain_endpoints ?? chains.length}</span>
          <span className="summary-label">Brain Endpoints</span>
        </div>

        <div className="summary-card stat-full">
          <span className="summary-count">{summary?.full_chain_count ?? 0}</span>
          <span className="summary-label">Full Chain (to UI)</span>
        </div>

        <div className="summary-card stat-client">
          <span className="summary-count">{summary?.client_api_count ?? 0}</span>
          <span className="summary-label">Client API Ready</span>
        </div>

        <div className="summary-card stat-backend">
          <span className="summary-count">{summary?.backend_exposed_count ?? 0}</span>
          <span className="summary-label">Backend Exposed</span>
        </div>

        <div className="summary-card stat-internal">
          <span className="summary-count">{summary?.unexposed_count ?? 0}</span>
          <span className="summary-label">Internal Only</span>
        </div>

        <div className="summary-app-split">
          <span className="app-split-pill pill-admin">
            Admin: <strong>{summary?.admin_connected_count ?? 0}</strong>
          </span>
          <span className="app-split-pill pill-frontend">
            Frontend: <strong>{summary?.frontend_connected_count ?? 0}</strong>
          </span>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="lineage-error-banner">
          <span>⚠️ {error}</span>
          <button className="btn-sm" onClick={() => void lineageStore.rescan()}>
            Retry Scan
          </button>
        </div>
      )}

      {/* Workspace Body */}
      <div className="lineage-body">
        <LineageSidebar
          collapsed={sidebarCollapsed}
          onSelectChain={handleSelectChain}
        />

        <main className="lineage-main-content">
          {loading ? (
            <div className="lineage-loading-state">
              <div className="loading-spinner" />
              <p>Scanning full stack AST lineage across Brain, Backend, Frontend & Admin…</p>
            </div>
          ) : selectedChain ? (
            <div className="lineage-view-container">
              <LineageHeader />

              <div className="lineage-view-body">
                {viewMode === "tree" ? (
                  <LineageHierarchyTree />
                ) : viewMode === "graph" ? (
                  <LineageGraphView />
                ) : (
                  <LineageSwimlane chain={selectedChain} />
                )}
              </div>
            </div>
          ) : (
            <div className="rt-state">
              Select an endpoint from the sidebar to inspect its full stack lineage.
            </div>
          )}
        </main>
      </div>

      {/* Code Inspector Drawer */}
      {drawerOpen && selectedNodeDetail && (
        <LineageDetailDrawer
          detail={selectedNodeDetail}
          onClose={() => lineageStore.setDrawerOpen(false)}
        />
      )}
    </div>
  );
}

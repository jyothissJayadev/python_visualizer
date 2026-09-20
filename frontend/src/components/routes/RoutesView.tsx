import { useEffect } from "react";
import { routesStore } from "../../lib/routesStore";
import { useRoutes } from "../../lib/useRoutes";
import { EndpointSidebar } from "./EndpointSidebar";
import { EndpointHeader } from "./EndpointHeader";
import { HierarchyTree } from "./HierarchyTree";
import { FlowGraph } from "./FlowGraph";
import { NodeDetail } from "./NodeDetail";
import { EndpointData } from "./EndpointData";
import { TableDetail } from "./TableDetail";
import "../../routes.css";

interface Props {
  active: boolean;
  urlEndpointId?: string;
  sidebarCollapsed: boolean;
  onEndpointChange: (id: string) => void;
}

/** The Routes tab: endpoints (left) -> call hierarchy (centre) -> details (right). */
export function RoutesView({ active, urlEndpointId, sidebarCollapsed, onEndpointChange }: Props) {
  const s = useRoutes();

  useEffect(() => {
    routesStore.start();
  }, []);

  // URL -> selection (deep links, back/forward)
  useEffect(() => {
    if (urlEndpointId && urlEndpointId !== routesStore.getSnapshot().selectedId) {
      void routesStore.select(urlEndpointId);
    }
  }, [urlEndpointId]);

  // nothing selected yet: open the first endpoint once the listing is there
  useEffect(() => {
    if (!active || s.selectedId || urlEndpointId || !s.listing) return;
    const first = s.listing.groups[0]?.endpoints[0];
    if (first) onEndpointChange(first.id);
  }, [active, s.selectedId, urlEndpointId, s.listing, onEndpointChange]);

  // Escape key closes the details drawer
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape" && routesStore.getSnapshot().drawerOpen) {
        routesStore.setDrawerOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);

  const analyzing = !s.analysis?.ready;

  return (
    <div className="rt-workspace">
      <EndpointSidebar collapsed={sidebarCollapsed} onSelect={onEndpointChange} />

      <main className="rt-main">
        {s.selectedId ? (
          <>
            <EndpointHeader />
            <div className="rt-body">
              {s.treeLoading && !s.tree && s.view !== "data" && (
                <div className="rt-state"><span className="rt-spinner big" /> Building the call hierarchy…</div>
              )}
              {s.treeError && (
                <div className="rt-state warn">
                  {s.treeError}
                  <button className="rt-btn" onClick={() => void routesStore.select(s.selectedId!)}>Retry</button>
                </div>
              )}
              {s.view === "data" ? <EndpointData /> : s.tree && (s.view === "tree" ? <HierarchyTree /> : <FlowGraph />)}
              {s.tree && s.treeLoading && <div className="rt-busy"><span className="rt-spinner" /> Loading…</div>}
            </div>
            {s.tree && s.view === "tree" && (
              <div className="rt-legend">
                <span><i className="rt-glyph k-function">ƒ</i> your function</span>
                <span><span className="rt-tag edge-spawn">spawn</span> background task</span>
                <span><span className="rt-tag edge-depends">Depends</span> FastAPI dependency</span>
                <span><span className="rt-tag cyc">↺ recursive</span></span>
                <span><span className="rt-lib">N lib</span> library calls — see details panel</span>
                <span className="rt-legend-keys">↑↓ move · ←→ collapse/expand · ⏎ toggle</span>
              </div>
            )}
          </>
        ) : (
          <div className="rt-state">
            {analyzing ? (<><span className="rt-spinner big" /> Analyzing the project…</>) : "Select an endpoint from the list to see its function hierarchy."}
          </div>
        )}
      </main>

      {s.selectedId && s.drawerOpen && (s.view === "data" ? <TableDetail /> : <NodeDetail />)}
    </div>
  );
}

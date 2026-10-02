import type { AppTab } from "../lib/router";
import { store } from "../lib/store";
import { routesStore } from "../lib/routesStore";
import { databaseStore } from "../lib/databaseStore";
import { lineageStore } from "../lib/lineageStore";
import { useRoutesValue } from "../lib/useRoutes";
import { useTerminal } from "../lib/useTerminal";
import { useDatabase } from "../lib/useDatabase";
import { useLineage } from "../lib/useLineage";
import { TabsSlider } from "./TabsSlider";
import { ToolbarStreamMenu } from "./ToolbarStreamMenu";

interface Props {
  catalogCollapsed: boolean;
  onToggleCatalog: () => void;
  routesSidebarCollapsed?: boolean;
  onToggleRoutesSidebar?: () => void;
  databaseSidebarCollapsed?: boolean;
  onToggleDatabaseSidebar?: () => void;
  lineageSidebarCollapsed?: boolean;
  onToggleLineageSidebar?: () => void;
  activeTab: AppTab;
  onSelectTab: (tab: AppTab) => void;
  routesCount?: number;
  databaseCount?: number;
  lineageCount?: number;
}

export function Toolbar({
  catalogCollapsed,
  onToggleCatalog,
  routesSidebarCollapsed = false,
  onToggleRoutesSidebar,
  databaseSidebarCollapsed = false,
  onToggleDatabaseSidebar,
  lineageSidebarCollapsed = false,
  onToggleLineageSidebar,
  activeTab,
  onSelectTab,
  routesCount = 0,
  databaseCount = 16,
  lineageCount = 0,
}: Props) {
  const s = useTerminal();
  const rescanning = useRoutesValue((r) => r.rescanning || r.analysis?.status === "scanning");
  const db = useDatabase();
  const lineage = useLineage();

  const isRailCollapsed =
    activeTab === "terminal"
      ? catalogCollapsed
      : activeTab === "routes"
      ? routesSidebarCollapsed
      : activeTab === "database"
      ? databaseSidebarCollapsed
      : lineageSidebarCollapsed;

  const onToggleRail =
    activeTab === "terminal"
      ? onToggleCatalog
      : activeTab === "routes"
      ? (onToggleRoutesSidebar || onToggleCatalog)
      : activeTab === "database"
      ? (onToggleDatabaseSidebar || onToggleCatalog)
      : (onToggleLineageSidebar || onToggleCatalog);

  const railTitle =
    activeTab === "terminal"
      ? "Toggle Function Catalog Rail"
      : activeTab === "routes"
      ? "Toggle Routes Sidebar Rail"
      : activeTab === "database"
      ? "Toggle Database Sidebar Rail"
      : "Toggle Lineage Sidebar Rail";

  return (
    <header className="app-toolbar">
      <div className="toolbar-left">
        {/* Toggle sidebar rail icon */}
        <button
          className={"btn-icon" + (isRailCollapsed ? "" : " active")}
          title={railTitle}
          onClick={onToggleRail}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 3h18v18H3zM9 3v18" />
          </svg>
        </button>

        <div className="app-brand">
          <span className="brain-icon">🧠</span>
          <span>Brain Terminal</span>
        </div>

        {/* Top Views Tabs Slider */}
        <TabsSlider
          activeTab={activeTab}
          onSelectTab={onSelectTab}
          routesCount={routesCount}
          databaseCount={databaseCount}
          lineageCount={lineageCount}
          totalEvents={s.totalEvents}
        />

        {/* Terminal Specific Toolbar Actions */}
        {activeTab === "terminal" && (
          <div className="toolbar-actions">
            <div className="search-filter-box">
              <svg className="search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
              <input
                type="text"
                placeholder="Filter request_id or text..."
                value={s.filterQuery}
                onChange={(e) => store.setFilterQuery(e.target.value)}
              />
              {s.filterQuery && (
                <button
                  type="button"
                  className="search-clear-btn"
                  onClick={() => store.setFilterQuery("")}
                  title="Clear filter"
                >
                  ✕
                </button>
              )}
            </div>

            <ToolbarStreamMenu />
          </div>
        )}

        {/* Method Routes Specific Actions */}
        {activeTab === "routes" && (
          <div className="toolbar-actions">
            <button
              className="btn-sm"
              title="Re-analyze brain's source: endpoints and call hierarchy"
              disabled={rescanning}
              onClick={() => void routesStore.rescan()}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
              </svg>
              {rescanning ? "Analyzing…" : "Rescan"}
            </button>
          </div>
        )}

        {/* Database Specific Actions */}
        {activeTab === "database" && (
          <div className="toolbar-actions">
            <button
              className="btn-sm"
              title="Rescan Brain's MongoDB & Neo4j Schemas"
              disabled={db.rescanning}
              onClick={() => void databaseStore.rescan()}
            >
              <svg
                className={db.rescanning ? "spin" : ""}
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
              </svg>
              {db.rescanning ? "Scanning…" : "Rescan Schemas"}
            </button>
          </div>
        )}

        {/* Lineage Cross-Layer Actions */}
        {activeTab === "lineage" && (
          <div className="toolbar-actions">
            <div className="search-filter-box">
              <svg className="search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
              <input
                type="text"
                placeholder="Search Brain endpoint, backend route, UI component..."
                value={lineage.searchQuery}
                onChange={(e) => lineageStore.setSearch(e.target.value)}
              />
              {lineage.searchQuery && (
                <button
                  className="search-clear-btn"
                  onClick={() => lineageStore.setSearch("")}
                  title="Clear search"
                >
                  ✕
                </button>
              )}
            </div>

            <button
              className="btn-sm"
              title="Re-analyze end-to-end full stack lineage (Brain, Backend, Frontend, Admin)"
              disabled={lineage.rescanning}
              onClick={() => void lineageStore.rescan()}
            >
              <svg
                className={lineage.rescanning ? "spin" : ""}
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
              </svg>
              {lineage.rescanning ? "Scanning Stack…" : "Rescan Lineage"}
            </button>
            {!lineage.rescanning && (lineage.scanning || lineage.stale) && (
              <span
                className="lineage-stale-badge"
                title="Source files changed since this lineage was scanned"
                style={{ fontSize: 11, marginLeft: 8, opacity: 0.8 }}
              >
                {lineage.scanning ? "Code changed — rescanning…" : "Code changed — stale"}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="toolbar-right">
        <div className="status-pill" title="WebSocket Connection Status">
          <span
            className={
              "status-dot " +
              (s.connection === "connected"
                ? "connected"
                : s.connection === "reconnecting"
                  ? "reconnecting"
                  : "")
            }
          />
          <span>{s.connectionLabel}</span>
        </div>
      </div>
    </header>
  );
}

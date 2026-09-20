import { useEffect, useState } from "react";
import { store } from "./lib/store";
import { startSocket } from "./lib/socket";
import { useAppRouter } from "./lib/router";
import { Toolbar } from "./components/Toolbar";
import { CatalogPane } from "./components/CatalogPane";
import { CatalogModal } from "./components/CatalogModal";
import { StreamPane } from "./components/StreamPane";
import { InspectorPane } from "./components/InspectorPane";
import { Toast } from "./components/Toast";
import { RoutesView } from "./components/routes/RoutesView";
import { routesStore } from "./lib/routesStore";
import { useRoutesValue } from "./lib/useRoutes";
import { DatabaseWorkspace } from "./components/database/DatabaseWorkspace";
import { databaseStore } from "./lib/databaseStore";
import { useDatabase } from "./lib/useDatabase";

export default function App() {
  const { tab, endpointId, tableId, navigate } = useAppRouter();
  const [catalogCollapsed, setCatalogCollapsed] = useState(false);
  const [routesSidebarCollapsed, setRoutesSidebarCollapsed] = useState(false);
  const [databaseSidebarCollapsed, setDatabaseSidebarCollapsed] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const routesCount = useRoutesValue((r) => r.analysis?.endpoint_count ?? 0);
  const db = useDatabase();

  useEffect(() => {
    startSocket();
    void store.loadCatalog();
  }, []);

  return (
    <div id="app">
      <Toolbar
        catalogCollapsed={catalogCollapsed}
        onToggleCatalog={() => setCatalogCollapsed((v) => !v)}
        routesSidebarCollapsed={routesSidebarCollapsed}
        onToggleRoutesSidebar={() => setRoutesSidebarCollapsed((v) => !v)}
        databaseSidebarCollapsed={databaseSidebarCollapsed}
        onToggleDatabaseSidebar={() => setDatabaseSidebarCollapsed((v) => !v)}
        activeTab={tab}
        onSelectTab={(t) => {
          if (t === "routes") {
            navigate("routes", routesStore.getSnapshot().selectedId ?? undefined);
          } else if (t === "database") {
            navigate("database", databaseStore.getSnapshot().selectedTableId ?? undefined);
          } else {
            navigate("terminal");
          }
        }}
        routesCount={routesCount}
        databaseCount={db.schema.tables.length}
      />

      {/* Terminal View: Persists in DOM to keep WebSocket stream and span state alive */}
      <div
        className="workspace-body terminal-workspace"
        style={{ display: tab === "terminal" ? "flex" : "none" }}
      >
        <CatalogPane
          collapsed={catalogCollapsed}
          onOpenModal={() => setModalOpen(true)}
        />
        <StreamPane />
        <InspectorPane />
      </div>

      {/* Routes View: endpoints -> hierarchical call graph (see components/routes) */}
      <div
        className="workspace-body routes-workspace-wrapper"
        style={{ display: tab === "routes" ? "flex" : "none" }}
      >
        <RoutesView
          active={tab === "routes"}
          urlEndpointId={endpointId}
          sidebarCollapsed={routesSidebarCollapsed}
          onEndpointChange={(id) => navigate("routes", id)}
        />
      </div>

      {/* Database View: MongoDB & Neo4j ER, Lineage & Call Chains */}
      <div
        className="workspace-body database-workspace-wrapper"
        style={{ display: tab === "database" ? "flex" : "none" }}
      >
        <DatabaseWorkspace
          active={tab === "database"}
          urlTableId={tableId}
          sidebarCollapsed={databaseSidebarCollapsed}
          onTableChange={(id) => navigate("database", id)}
        />
      </div>

      <CatalogModal open={modalOpen} onClose={() => setModalOpen(false)} />
      <Toast />
    </div>
  );
}

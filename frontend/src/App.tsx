import { useEffect, useState } from "react";
import { store } from "./lib/store";
import { startSocket } from "./lib/socket";
import { useAppRouter } from "./lib/router";
import { loadInstance, useInstance } from "./lib/instance";
import { InstanceBadge } from "./components/InstanceBadge";
import { Toolbar } from "./components/Toolbar";
import { CatalogPane } from "./components/CatalogPane";
import { CatalogModal } from "./components/CatalogModal";
import { TemplateEditModal } from "./components/TemplateEditModal";
import type { Template } from "./types";
import { StreamPane } from "./components/StreamPane";
import { InspectorPane } from "./components/InspectorPane";
import { Toast } from "./components/Toast";
import { RoutesView } from "./components/routes/RoutesView";
import { routesStore } from "./lib/routesStore";
import { useRoutesValue } from "./lib/useRoutes";
import { DatabaseWorkspace } from "./components/database/DatabaseWorkspace";
import { databaseStore } from "./lib/databaseStore";
import { useDatabase } from "./lib/useDatabase";
import { LineageWorkspace } from "./components/lineage/LineageWorkspace";
import { lineageStore } from "./lib/lineageStore";
import { useLineageValue } from "./lib/useLineage";
import "./lineage.css";

export default function App() {
  const { tab, endpointId, tableId, lineageId, focusConnected, navigate } = useAppRouter();
  const { features } = useInstance();
  const [catalogCollapsed, setCatalogCollapsed] = useState(false);
  const [routesSidebarCollapsed, setRoutesSidebarCollapsed] = useState(false);
  const [databaseSidebarCollapsed, setDatabaseSidebarCollapsed] = useState(false);
  const [lineageSidebarCollapsed, setLineageSidebarCollapsed] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);

  const routesCount = useRoutesValue((r) => r.analysis?.endpoint_count ?? 0);
  const db = useDatabase();
  const lineageCount = useLineageValue((l) => l.summary?.full_chain_count ?? l.chains.length);

  useEffect(() => {
    startSocket();
    void loadInstance();
    void store.loadCatalog();
    void store.loadTemplates();
  }, []);

  // an instance may not offer the tab in the URL (e.g. #/database on a target without a database)
  useEffect(() => {
    if (tab !== "terminal" && !features.includes(tab)) navigate("terminal");
  }, [tab, features, navigate]);

  return (
    <div id="app">
      <InstanceBadge />
      <Toolbar
        catalogCollapsed={catalogCollapsed}
        onToggleCatalog={() => setCatalogCollapsed((v) => !v)}
        routesSidebarCollapsed={routesSidebarCollapsed}
        onToggleRoutesSidebar={() => setRoutesSidebarCollapsed((v) => !v)}
        databaseSidebarCollapsed={databaseSidebarCollapsed}
        onToggleDatabaseSidebar={() => setDatabaseSidebarCollapsed((v) => !v)}
        lineageSidebarCollapsed={lineageSidebarCollapsed}
        onToggleLineageSidebar={() => setLineageSidebarCollapsed((v) => !v)}
        activeTab={tab}
        onSelectTab={(t) => {
          if (t === "routes") {
            navigate("routes", routesStore.getSnapshot().selectedId ?? undefined);
          } else if (t === "database") {
            navigate("database", databaseStore.getSnapshot().selectedTableId ?? undefined);
          } else if (t === "lineage") {
            navigate("lineage", lineageStore.getSnapshot().selectedChainId ?? undefined);
          } else {
            navigate("terminal");
          }
        }}
        routesCount={routesCount}
        databaseCount={db.schema.tables.length}
        lineageCount={lineageCount}
      />

      {/* Terminal View: Persists in DOM to keep WebSocket stream and span state alive */}
      <div
        className="workspace-body terminal-workspace"
        style={{ display: tab === "terminal" ? "flex" : "none" }}
      >
        <CatalogPane
          collapsed={catalogCollapsed}
          onOpenModal={() => setModalOpen(true)}
          onEditTemplate={setEditingTemplate}
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
          urlFocusConnected={focusConnected}
          sidebarCollapsed={databaseSidebarCollapsed}
          onTableChange={(id) => navigate("database", id)}
        />
      </div>

      {/* Lineage View: End-to-End Brain -> Backend -> Client API -> UI Component Lineage */}
      <div
        className="workspace-body lineage-workspace-wrapper"
        style={{ display: tab === "lineage" ? "flex" : "none" }}
      >
        <LineageWorkspace
          active={tab === "lineage"}
          urlChainId={lineageId}
          sidebarCollapsed={lineageSidebarCollapsed}
          onChainChange={(id) => navigate("lineage", id)}
        />
      </div>

      <CatalogModal open={modalOpen} onClose={() => setModalOpen(false)} />
      <TemplateEditModal template={editingTemplate} onClose={() => setEditingTemplate(null)} />
      <Toast />
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { databaseStore } from "../../lib/databaseStore";
import { useDatabase } from "../../lib/useDatabase";
import { DatabaseSidebar } from "./DatabaseSidebar";
import { DatabaseDiagramCanvas } from "./DatabaseDiagramCanvas";
import { DatabaseMatrixView } from "./DatabaseMatrixView";
import { DatabaseDetailDrawer } from "./DatabaseDetailDrawer";
import "../../database.css";

interface Props {
  active: boolean;
  urlTableId?: string;
  urlFocusConnected?: boolean;
  sidebarCollapsed: boolean;
  onTableChange: (id: string) => void;
}

export function DatabaseWorkspace({
  active,
  urlTableId,
  urlFocusConnected,
  sidebarCollapsed,
  onTableChange,
}: Props) {
  const db = useDatabase();
  const [drawerOpen, setDrawerOpen] = useState(true);
  const hasInitializedRef = useRef(false);

  // Sync URL table param -> store selection
  useEffect(() => {
    if (urlTableId && urlTableId !== databaseStore.getSnapshot().selectedTableId) {
      databaseStore.select(urlTableId);
    }
  }, [urlTableId]);

  // Sync URL focus param -> store focus
  useEffect(() => {
    if (urlFocusConnected !== undefined) {
      databaseStore.setFocusConnectedOnly(urlFocusConnected);
    }
  }, [urlFocusConnected]);

  // Initial table selection (only once on load)
  useEffect(() => {
    if (active && !hasInitializedRef.current && db.schema.tables.length > 0) {
      hasInitializedRef.current = true;
      if (!urlTableId && !db.selectedTableId) {
        const firstId = db.schema.tables[0]?.id;
        if (firstId) {
          onTableChange(firstId);
        }
      }
    }
  }, [active, urlTableId, db.selectedTableId, db.schema.tables, onTableChange]);

  const filteredTables = databaseStore.getFilteredTables();
  const visibleTables = databaseStore.getVisibleTables();
  const filteredRelationships = databaseStore.getFilteredRelationships();
  const selectedTable = databaseStore.getSelectedTable();

  // Quick stats
  const totalTables = db.schema.tables.length;
  const mongoCount = db.schema.tables.filter((t) => t.database === "mongodb").length;
  const neo4jCount = db.schema.tables.filter((t) => t.database === "neo4j").length;
  const crossCount = db.schema.relationships.filter((r) => r.type === "cross_database").length;

  const handleSelectTable = (id: string) => {
    databaseStore.select(id);
    onTableChange(id);
    setDrawerOpen(true);
  };

  return (
    <div className="db-workspace-layout">
      {/* Top Database Sub-Toolbar / Stats Strip */}
      <div className="db-sub-header">
        <div className="db-stats-group">
          <div className="db-stat-pill" title="Total database collections and graph nodes">
            <span className="stat-label">MODELS:</span>
            <span className="stat-value">{totalTables}</span>
            <span className="stat-breakdown">({mongoCount} Mongo · {neo4jCount} Neo4j)</span>
          </div>

          <div className="db-stat-pill cross" title="Cross-Database Links between MongoDB and Neo4j">
            <span className="stat-label">CROSS-DB:</span>
            <span className="stat-value">{crossCount}</span>
            <span className="stat-breakdown">links</span>
          </div>

          <div className="db-stat-pill" title="Total relationships mapped across databases">
            <span className="stat-label">TOTAL RELATIONS:</span>
            <span className="stat-value">{db.schema.relationships.length}</span>
          </div>
        </div>

        <div className="db-actions-group">
          {/* View Toggle (Canvas ER vs Matrix) */}
          <div className="db-view-switch" role="tablist">
            <button
              type="button"
              className={`db-switch-btn ${db.viewMode === "canvas" ? "active" : ""}`}
              onClick={() => databaseStore.setViewMode("canvas")}
              title="Interactive Pan & Zoom ER Diagram"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
              </svg>
              <span>Diagram</span>
            </button>
            <button
              type="button"
              className={`db-switch-btn ${db.viewMode === "matrix" ? "active" : ""}`}
              onClick={() => databaseStore.setViewMode("matrix")}
              title="Full Tabular Schema Matrix"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
              <span>Matrix</span>
            </button>
          </div>

          {/* Connected Only Focus Toggle */}
          <button
            type="button"
            className={`db-switch-btn ${db.focusConnectedOnly ? "active" : ""}`}
            onClick={() => databaseStore.toggleFocusConnectedOnly()}
            title={
              db.focusConnectedOnly
                ? "Exit focus mode and show all tables"
                : selectedTable
                ? `Only show ${selectedTable.name} and connected tables on canvas`
                : "Select a table to isolate it and its connected tables"
            }
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="4" />
              <line x1="12" y1="2" x2="12" y2="4" />
              <line x1="12" y1="20" x2="12" y2="22" />
              <line x1="2" y1="12" x2="4" y2="12" />
              <line x1="20" y1="12" x2="22" y2="12" />
            </svg>
            <span>Connected Only</span>
            {db.focusConnectedOnly && (
              <span className="db-badge-count">{visibleTables.length}</span>
            )}
          </button>

          {/* Drawer Toggle */}
          <button
            type="button"
            className={`db-switch-btn ${drawerOpen ? "active" : ""}`}
            onClick={() => setDrawerOpen((v) => !v)}
            title={drawerOpen ? "Hide detail drawer" : "Show detail drawer"}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="15" y1="3" x2="15" y2="21" />
            </svg>
            <span>{drawerOpen ? "Hide Drawer" : "Inspect Table"}</span>
          </button>

          {db.lastRescannedAt && (
            <span className="db-timestamp-pill" title="Timestamp of last AST schema discovery">
              synced {db.lastRescannedAt}
            </span>
          )}
        </div>
      </div>

      {/* Main Workspace Body */}
      <div className="db-workspace-main">
        {/* Left Sidebar */}
        <DatabaseSidebar
          collapsed={sidebarCollapsed}
          tables={filteredTables}
          selectedTableId={db.selectedTableId}
          enabledTableIds={db.enabledTableIds}
          focusConnectedOnly={db.focusConnectedOnly}
          searchQuery={db.searchQuery}
          databaseFilter={db.databaseFilter}
          domainFilter={db.domainFilter}
          audit={db.codeAudit}
          codeState={db.codeState}
          codeError={db.codeError}
          onSelectTable={handleSelectTable}
          onToggleTableEnabled={(id) => databaseStore.toggleTableEnabled(id)}
          onToggleFocusConnected={() => databaseStore.toggleFocusConnectedOnly()}
          onEnableAll={() => databaseStore.enableAllTables()}
          onDisableAll={() => databaseStore.disableAllTables()}
          onSearchChange={(q) => databaseStore.setSearchQuery(q)}
          onDatabaseFilterChange={(f) => databaseStore.setDatabaseFilter(f)}
          onDomainFilterChange={(d) => databaseStore.setDomainFilter(d)}
        />

        {/* Center Content: Canvas or Matrix */}
        <div className="db-center-pane">
          {db.viewMode === "canvas" ? (
            <DatabaseDiagramCanvas
              tables={visibleTables}
              relationships={filteredRelationships}
              selectedTableId={db.selectedTableId}
              relationFilter={db.relationFilter}
              focusConnectedOnly={db.focusConnectedOnly}
              onSelectTable={handleSelectTable}
              onFilterRelationChange={(rf) => databaseStore.setRelationFilter(rf)}
              onToggleFocusConnected={(f) => databaseStore.setFocusConnectedOnly(f)}
            />
          ) : (
            <DatabaseMatrixView
              tables={filteredTables}
              selectedTableId={db.selectedTableId}
              enabledTableIds={db.enabledTableIds}
              onSelectTable={handleSelectTable}
              onToggleTableEnabled={(id) => databaseStore.toggleTableEnabled(id)}
            />
          )}
        </div>

        {/* Right Detail Drawer */}
        {drawerOpen && selectedTable && (
          <DatabaseDetailDrawer
            table={selectedTable}
            relationships={db.schema.relationships}
            activeTab={db.activeDrawerTab}
            focusConnectedOnly={db.focusConnectedOnly}
            onToggleFocusConnected={(f) => databaseStore.setFocusConnectedOnly(f)}
            onTabChange={(tab) => databaseStore.setActiveDrawerTab(tab)}
            onSelectTable={handleSelectTable}
            onClose={() => setDrawerOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

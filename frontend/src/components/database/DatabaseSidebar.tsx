import type { DatabaseTable } from "../../lib/databaseEngine";
import type { DatabaseFilter, DomainFilter } from "../../lib/databaseStore";
import type { SchemaAudit } from "../../lib/databaseCode";
import { SchemaAuditPanel } from "./SchemaAuditPanel";

interface Props {
  collapsed: boolean;
  tables: DatabaseTable[];
  selectedTableId: string | null;
  enabledTableIds: Set<string>;
  searchQuery: string;
  databaseFilter: DatabaseFilter;
  domainFilter: DomainFilter;
  audit: SchemaAudit | null;
  codeState: "idle" | "loading" | "ready" | "error";
  codeError: string | null;
  onSelectTable: (id: string) => void;
  onToggleTableEnabled: (id: string) => void;
  onEnableAll: () => void;
  onDisableAll: () => void;
  onSearchChange: (q: string) => void;
  onDatabaseFilterChange: (db: DatabaseFilter) => void;
  onDomainFilterChange: (domain: DomainFilter) => void;
}

export function DatabaseSidebar({
  collapsed,
  tables,
  selectedTableId,
  enabledTableIds,
  searchQuery,
  databaseFilter,
  domainFilter,
  audit,
  codeState,
  codeError,
  onSelectTable,
  onToggleTableEnabled,
  onEnableAll,
  onDisableAll,
  onSearchChange,
  onDatabaseFilterChange,
  onDomainFilterChange,
}: Props) {
  if (collapsed) return null;

  const mongoCount = tables.filter((t) => t.database === "mongodb").length;
  const neo4jCount = tables.filter((t) => t.database === "neo4j").length;
  const enabledCount = tables.filter((t) => enabledTableIds.has(t.id)).length;

  // Group filtered tables by domain
  const domains: { key: DomainFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "quotation", label: "Quotation" },
    { key: "execution", label: "Execution" },
    { key: "chat", label: "Chat" },
    { key: "shared", label: "Shared" },
  ];

  return (
    <aside className="db-sidebar">
      {/* Search Filter Header */}
      <div className="db-sidebar-header">
        <div className="db-search-box">
          <svg className="db-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="text"
            className="db-search-input"
            placeholder="Filter tables, fields, functions..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
          />
          {searchQuery && (
            <button className="db-clear-search-btn" onClick={() => onSearchChange("")} title="Clear search">
              ✕
            </button>
          )}
        </div>

        {/* Database Selector Segmented Control */}
        <div className="db-database-selector" role="tablist">
          <button
            type="button"
            className={`db-tab-pill ${databaseFilter === "all" ? "active" : ""}`}
            onClick={() => onDatabaseFilterChange("all")}
          >
            All <span className="pill-count">{tables.length}</span>
          </button>
          <button
            type="button"
            className={`db-tab-pill mongo ${databaseFilter === "mongodb" ? "active" : ""}`}
            onClick={() => onDatabaseFilterChange("mongodb")}
            title="MongoDB Motor Collections + Beanie ODM"
          >
            MongoDB <span className="pill-count">{mongoCount}</span>
          </button>
          <button
            type="button"
            className={`db-tab-pill neo4j ${databaseFilter === "neo4j" ? "active" : ""}`}
            onClick={() => onDatabaseFilterChange("neo4j")}
            title="Neo4j Knowledge & Ontology Graphs"
          >
            Neo4j <span className="pill-count">{neo4jCount}</span>
          </button>
        </div>

        {/* Domain Filter Pills */}
        <div className="db-domain-filters">
          {domains.map((d) => (
            <button
              key={d.key}
              type="button"
              className={`db-domain-chip ${domainFilter === d.key ? "active" : ""}`}
              onClick={() => onDomainFilterChange(d.key)}
            >
              {d.label}
            </button>
          ))}
        </div>

        <SchemaAuditPanel audit={audit} state={codeState} error={codeError} onSelectTable={onSelectTable} />
      </div>

      {/* Table / Collection List */}
      <div className="db-table-list">
        <div className="db-list-section-header">
          <div className="db-section-title-group">
            <span>VIEW CHECKLIST</span>
            <span className="db-enabled-count">
              {enabledCount}/{tables.length}
            </span>
          </div>

          <div className="db-checklist-actions">
            <button
              type="button"
              className="db-checklist-btn"
              onClick={onEnableAll}
              title="Show all tables in view mode"
            >
              All
            </button>
            <button
              type="button"
              className="db-checklist-btn"
              onClick={onDisableAll}
              title="Hide all tables in view mode"
            >
              None
            </button>
          </div>
        </div>

        {tables.length === 0 ? (
          <div className="db-empty-list">No matching tables or graph nodes found.</div>
        ) : (
          tables.map((table) => {
            const isSelected = selectedTableId === table.id;
            const isEnabled = enabledTableIds.has(table.id);
            const isMongo = table.database === "mongodb";
            const hasCrossDbRef = table.fields.some(
              (f) => f.foreignTarget && (f.foreignTarget.includes("neo4j:") || f.foreignTarget.includes("mongo:"))
            );

            return (
              <div
                key={table.id}
                className={`db-list-item db-theme-${table.database} ${isSelected ? "selected" : ""} ${
                  isEnabled ? "is-enabled" : "is-disabled"
                }`}
                onClick={() => onSelectTable(table.id)}
              >
                <div className="db-item-row-top">
                  <input
                    type="checkbox"
                    className="db-table-checkbox"
                    checked={isEnabled}
                    onChange={(e) => {
                      e.stopPropagation();
                      onToggleTableEnabled(table.id);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    title={isEnabled ? "Hide from view mode" : "Show in view mode"}
                  />
                  <span className={`db-type-dot ${table.database}`} />
                  <span className="db-item-name" title={table.name}>
                    {table.name}
                  </span>
                </div>

                <div className="db-item-row-meta">
                  <span className={`db-mini-badge engine ${table.database}`}>
                    {isMongo ? "mongo" : "neo4j"}
                  </span>
                  <span className="db-mini-badge domain">{table.domain}</span>
                  <span className="db-mini-stat">{table.fields.length}f</span>
                  <span className="db-mini-stat fn">ƒ{table.functions.length}</span>
                  {hasCrossDbRef && (
                    <span className="db-cross-tag" title="Cross-Database foreign key">
                      ⇄ cross-db
                    </span>
                  )}
                </div>

                <div className="db-item-row-methods">
                  {Array.from(new Set(table.endpoints.map((e) => e.method))).map((m) => (
                    <span key={m} className={`db-method-micro-tag ${m.toLowerCase()}`}>
                      {m}
                    </span>
                  ))}
                  <span className="db-fn-ops-micro">
                    {table.functions.some((f) => f.op === "read") && <i className="op-r">R</i>}
                    {table.functions.some((f) => f.op === "write") && <i className="op-w">W</i>}
                    {table.functions.some((f) => f.op === "upsert") && <i className="op-u">U</i>}
                    {table.functions.some((f) => f.op === "delete") && <i className="op-d">D</i>}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

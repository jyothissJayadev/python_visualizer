import { useState } from "react";
import type {
  DatabaseRelationship,
  DatabaseTable,
} from "../../lib/databaseEngine";
import type { DrawerTab } from "../../lib/databaseStore";

interface Props {
  table: DatabaseTable | null;
  relationships: DatabaseRelationship[];
  activeTab: DrawerTab;
  focusConnectedOnly?: boolean;
  onToggleFocusConnected?: (focus: boolean) => void;
  onTabChange: (tab: DrawerTab) => void;
  onSelectTable: (id: string) => void;
  onClose: () => void;
}

export function DatabaseDetailDrawer({
  table,
  relationships,
  activeTab,
  focusConnectedOnly = false,
  onToggleFocusConnected,
  onTabChange,
  onSelectTable,
  onClose,
}: Props) {
  const [copiedFn, setCopiedFn] = useState<string | null>(null);
  const [methodFilter, setMethodFilter] = useState<string>("all");
  const [opFilter, setOpFilter] = useState<string>("all");

  if (!table) return null;

  const isMongo = table.database === "mongodb";

  // Filter incoming and outgoing relationships for this table
  const outgoingRels = relationships.filter((r) => r.fromTableId === table.id);
  const incomingRels = relationships.filter((r) => r.toTableId === table.id);

  // Method counts
  const getCount = table.endpoints.filter((e) => e.method === "GET").length;
  const postCount = table.endpoints.filter((e) => e.method === "POST").length;
  const putCount = table.endpoints.filter((e) => e.method === "PUT").length;
  const deleteCount = table.endpoints.filter((e) => e.method === "DELETE").length;

  const filteredEndpoints =
    methodFilter === "all"
      ? table.endpoints
      : table.endpoints.filter((e) => e.method === methodFilter);

  // Function op counts
  const readCount = table.functions.filter((f) => f.op === "read").length;
  const writeCount = table.functions.filter((f) => f.op === "write").length;
  const upsertCount = table.functions.filter((f) => f.op === "upsert").length;
  const fnDeleteCount = table.functions.filter((f) => f.op === "delete").length;

  const filteredFunctions =
    opFilter === "all"
      ? table.functions
      : table.functions.filter((f) => f.op === opFilter);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard?.writeText(text);
    setCopiedFn(id);
    setTimeout(() => setCopiedFn(null), 1800);
  };

  return (
    <aside className="db-drawer">
      {/* Drawer Header */}
      <div className="db-drawer-header">
        <div className="db-drawer-title-group">
          <div className="db-drawer-badge-row">
            <span className={`db-card-engine-tag ${table.database}`}>
              {isMongo ? "MongoDB (Motor / Beanie)" : "Neo4j Cypher Graph"}
            </span>
            <span className="db-badge-domain">{table.domain}</span>
            <span className="db-badge-type">{table.type}</span>
          </div>

          <h2 className="db-drawer-title" title={table.id}>
            {table.name}
          </h2>
          <p className="db-drawer-doc">{table.doc}</p>

          <div className="db-drawer-crud-summary">
            <span className="summary-label">HTTP Methods:</span>
            <span className={`db-method-pill mini get ${getCount > 0 ? "" : "muted"}`}>GET</span>
            <span className={`db-method-pill mini post ${postCount > 0 ? "" : "muted"}`}>POST</span>
            <span className={`db-method-pill mini put ${putCount > 0 ? "" : "muted"}`}>PUT</span>
            <span className={`db-method-pill mini delete ${deleteCount > 0 ? "" : "muted"}`}>DELETE</span>
          </div>
        </div>

        <div className="db-drawer-header-actions">
          <button
            type="button"
            className={`db-drawer-isolate-btn ${focusConnectedOnly ? "active" : ""}`}
            onClick={() => onToggleFocusConnected?.(!focusConnectedOnly)}
            title={
              focusConnectedOnly
                ? "Exit focus mode and show all tables on canvas"
                : `Isolate ${table.name} and its connected tables on canvas`
            }
          >
            <span>🎯</span>
            <span>{focusConnectedOnly ? "Connected Only" : "Isolate on Canvas"}</span>
          </button>
          <button className="db-drawer-close-btn" onClick={onClose} title="Close drawer">
            ✕
          </button>
        </div>
      </div>

      {/* Drawer Tabs */}
      <div className="db-drawer-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className={`db-drawer-tab-btn ${activeTab === "schema" ? "active" : ""}`}
          onClick={() => onTabChange("schema")}
        >
          Fields <span className="tab-pill-count">{table.fields.length}</span>
        </button>

        <button
          type="button"
          role="tab"
          className={`db-drawer-tab-btn ${activeTab === "functions" ? "active" : ""}`}
          onClick={() => onTabChange("functions")}
        >
          Functions <span className="tab-pill-count">{table.functions.length}</span>
        </button>

        <button
          type="button"
          role="tab"
          className={`db-drawer-tab-btn ${activeTab === "endpoints" ? "active" : ""}`}
          onClick={() => onTabChange("endpoints")}
        >
          Endpoints <span className="tab-pill-count">{table.endpoints.length}</span>
        </button>

        <button
          type="button"
          role="tab"
          className={`db-drawer-tab-btn ${activeTab === "relations" ? "active" : ""}`}
          onClick={() => onTabChange("relations")}
        >
          Links <span className="tab-pill-count">{outgoingRels.length + incomingRels.length}</span>
        </button>

        <button
          type="button"
          role="tab"
          className={`db-drawer-tab-btn ${activeTab === "indexes" ? "active" : ""}`}
          onClick={() => onTabChange("indexes")}
        >
          Indexes <span className="tab-pill-count">{table.indexes.length}</span>
        </button>
      </div>

      {/* Drawer Body */}
      <div className="db-drawer-body">
        {/* Tab 1: Schema / Fields */}
        {activeTab === "schema" && (
          <div className="db-drawer-section">
            <div className="db-section-header">
              <span>FIELD SPECIFICATIONS</span>
              <span className="db-count-badge">{table.fields.length} columns</span>
            </div>

            <table className="db-fields-table">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Type</th>
                  <th>Constraints & References</th>
                </tr>
              </thead>
              <tbody>
                {table.fields.map((field) => (
                  <tr key={field.name}>
                    <td className="field-name-cell">
                      <span className="field-name">{field.name}</span>
                      {field.doc && <span className="field-doc">{field.doc}</span>}
                    </td>
                    <td className="field-type-cell">
                      <code>{field.type}</code>
                    </td>
                    <td className="field-constraint-cell">
                      {field.isPrimary && (
                        <span className="db-key-pill pk" title="Primary Identifier">
                          PRIMARY KEY
                        </span>
                      )}
                      {field.isForeign && field.foreignTarget && (
                        <span
                          className={`db-key-pill fk ${
                            field.foreignTarget.includes("neo4j:") || field.foreignTarget.includes("mongo:")
                              ? "cross"
                              : ""
                          }`}
                          onClick={() => {
                            const targetTableId = field.foreignTarget!.split(".")[0];
                            if (targetTableId) onSelectTable(targetTableId);
                          }}
                          title={`Click to inspect target: ${field.foreignTarget}`}
                        >
                          → {field.foreignTarget}
                        </span>
                      )}
                      {!field.isPrimary && !field.isForeign && <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Tab 2: Involved Functions */}
        {activeTab === "functions" && (
          <div className="db-drawer-section">
            <div className="db-section-header">
              <span>INVOLVED PYTHON FUNCTIONS</span>
              <span className="db-count-badge">{filteredFunctions.length} / {table.functions.length} functions</span>
            </div>

            <p className="db-section-description">
              AST analyzer detected these functions executing Motor queries, Beanie model updates, or Neo4j Cypher statements against this table.
            </p>

            {/* Function Operation Filter Bar */}
            <div className="db-filter-bar">
              <button
                type="button"
                className={`db-filter-tab-pill ${opFilter === "all" ? "active" : ""}`}
                onClick={() => setOpFilter("all")}
              >
                All ({table.functions.length})
              </button>
              {readCount > 0 && (
                <button
                  type="button"
                  className={`db-filter-tab-pill ${opFilter === "read" ? "active" : ""}`}
                  onClick={() => setOpFilter("read")}
                >
                  READ ({readCount})
                </button>
              )}
              {writeCount > 0 && (
                <button
                  type="button"
                  className={`db-filter-tab-pill ${opFilter === "write" ? "active" : ""}`}
                  onClick={() => setOpFilter("write")}
                >
                  WRITE ({writeCount})
                </button>
              )}
              {upsertCount > 0 && (
                <button
                  type="button"
                  className={`db-filter-tab-pill ${opFilter === "upsert" ? "active" : ""}`}
                  onClick={() => setOpFilter("upsert")}
                >
                  UPSERT ({upsertCount})
                </button>
              )}
              {fnDeleteCount > 0 && (
                <button
                  type="button"
                  className={`db-filter-tab-pill ${opFilter === "delete" ? "active" : ""}`}
                  onClick={() => setOpFilter("delete")}
                >
                  DELETE ({fnDeleteCount})
                </button>
              )}
            </div>

            <div className="db-fn-list">
              {filteredFunctions.map((fn) => (
                <div key={fn.fnId} className="db-fn-card">
                  <div className="db-fn-header">
                    <span className={`db-badge-op-large ${fn.op}`}>
                      {fn.op.toUpperCase()}
                    </span>
                    <div className="db-fn-title-box">
                      <span className="db-fn-name">{fn.name}</span>
                      <span className="db-fn-pkg">{fn.package}</span>
                    </div>
                    <button
                      className="db-copy-btn"
                      onClick={() => copyToClipboard(fn.fnId, fn.fnId)}
                      title="Copy function reference path"
                    >
                      {copiedFn === fn.fnId ? "✓ Copied" : "Copy"}
                    </button>
                  </div>
                  {fn.description && (
                    <div className="db-fn-desc">{fn.description}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tab 3: Connected Endpoints & Lineage */}
        {activeTab === "endpoints" && (
          <div className="db-drawer-section">
            <div className="db-section-header">
              <span>CALL-CHAIN LINEAGE FROM ENDPOINTS</span>
              <span className="db-count-badge">{filteredEndpoints.length} / {table.endpoints.length} API routes</span>
            </div>

            <p className="db-section-description">
              End-to-end call hierarchy trace showing which HTTP API endpoints reach this database model through downstream handler invocations.
            </p>

            {/* HTTP Method Filter Bar */}
            <div className="db-filter-bar">
              <button
                type="button"
                className={`db-filter-tab-pill ${methodFilter === "all" ? "active" : ""}`}
                onClick={() => setMethodFilter("all")}
              >
                All ({table.endpoints.length})
              </button>
              {getCount > 0 && (
                <button
                  type="button"
                  className={`db-filter-tab-pill ${methodFilter === "GET" ? "active" : ""}`}
                  onClick={() => setMethodFilter("GET")}
                >
                  GET ({getCount})
                </button>
              )}
              {postCount > 0 && (
                <button
                  type="button"
                  className={`db-filter-tab-pill ${methodFilter === "POST" ? "active" : ""}`}
                  onClick={() => setMethodFilter("POST")}
                >
                  POST ({postCount})
                </button>
              )}
              {putCount > 0 && (
                <button
                  type="button"
                  className={`db-filter-tab-pill ${methodFilter === "PUT" ? "active" : ""}`}
                  onClick={() => setMethodFilter("PUT")}
                >
                  PUT ({putCount})
                </button>
              )}
              {deleteCount > 0 && (
                <button
                  type="button"
                  className={`db-filter-tab-pill ${methodFilter === "DELETE" ? "active" : ""}`}
                  onClick={() => setMethodFilter("DELETE")}
                >
                  DELETE ({deleteCount})
                </button>
              )}
            </div>

            {filteredEndpoints.length === 0 ? (
              <div className="db-empty-state">
                No endpoints matching filter for this model.
              </div>
            ) : (
              <div className="db-lineage-list">
                {filteredEndpoints.map((ep) => (
                  <div key={ep.endpointId} className="db-lineage-card">
                    <div className="db-lineage-header">
                      <span className={`db-method-pill ${ep.method.toLowerCase()}`}>
                        {ep.method}
                      </span>
                      <span className="db-endpoint-path">{ep.path}</span>
                    </div>

                    {ep.summary && (
                      <div className="db-lineage-summary">{ep.summary}</div>
                    )}

                    <div className="db-call-chain-timeline">
                      <div className="timeline-title">CALL CHAIN HIERARCHY:</div>
                      {ep.callChain.map((step, idx) => (
                        <div key={step} className="timeline-step">
                          <span className="timeline-index">{idx + 1}</span>
                          <span className="timeline-step-name">{step}</span>
                          {idx < ep.callChain.length - 1 && (
                            <div className="timeline-connector" />
                          )}
                        </div>
                      ))}
                      <div className="timeline-step target">
                        <span className="timeline-index final">★</span>
                        <span className="timeline-step-name final">
                          {table.database === "mongodb" ? "MongoDB Collection" : "Neo4j Node"}: <b>{table.name}</b>
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tab 4: Direct Relationships */}
        {activeTab === "relations" && (
          <div className="db-drawer-section">
            <div className="db-section-header">
              <span>GRAPH & FOREIGN KEY RELATIONSHIPS</span>
              <span className="db-count-badge">
                {outgoingRels.length + incomingRels.length} total links
              </span>
            </div>

            {/* Canvas Focus Quick Action Bar */}
            <div className="db-relations-focus-bar">
              <button
                type="button"
                className={`db-relations-focus-toggle ${focusConnectedOnly ? "active" : ""}`}
                onClick={() => onToggleFocusConnected?.(!focusConnectedOnly)}
              >
                <span className="focus-icon">🎯</span>
                <span className="focus-text">
                  {focusConnectedOnly
                    ? `Showing ${table.name} + ${outgoingRels.length + incomingRels.length} connected tables`
                    : `Only view ${table.name} and connected tables (${outgoingRels.length + incomingRels.length}) in canvas`}
                </span>
                <span className="focus-action-pill">
                  {focusConnectedOnly ? "Exit Focus" : "Isolate in Canvas"}
                </span>
              </button>
            </div>

            {/* Outgoing Links */}
            <div className="db-rel-group">
              <div className="db-rel-sub-title">Outgoing Links ({outgoingRels.length})</div>
              {outgoingRels.length === 0 ? (
                <div className="db-empty-sub">No outgoing references.</div>
              ) : (
                outgoingRels.map((rel) => (
                  <div
                    key={rel.id}
                    className={`db-rel-card ${rel.type}`}
                    onClick={() => onSelectTable(rel.toTableId)}
                  >
                    <div className="db-rel-top">
                      <span className={`db-rel-type-tag ${rel.type}`}>{rel.type}</span>
                      <span className="db-rel-label">{rel.label}</span>
                    </div>
                    <div className="db-rel-target">
                      Points to: <b>{rel.toTableId}</b>
                    </div>
                    {rel.doc && <div className="db-rel-doc">{rel.doc}</div>}
                  </div>
                ))
              )}
            </div>

            {/* Incoming Links */}
            <div className="db-rel-group" style={{ marginTop: 16 }}>
              <div className="db-rel-sub-title">Incoming References ({incomingRels.length})</div>
              {incomingRels.length === 0 ? (
                <div className="db-empty-sub">No incoming references.</div>
              ) : (
                incomingRels.map((rel) => (
                  <div
                    key={rel.id}
                    className={`db-rel-card ${rel.type}`}
                    onClick={() => onSelectTable(rel.fromTableId)}
                  >
                    <div className="db-rel-top">
                      <span className={`db-rel-type-tag ${rel.type}`}>{rel.type}</span>
                      <span className="db-rel-label">{rel.label}</span>
                    </div>
                    <div className="db-rel-target">
                      Referenced by: <b>{rel.fromTableId}</b>
                    </div>
                    {rel.doc && <div className="db-rel-doc">{rel.doc}</div>}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Tab 5: Indexes */}
        {activeTab === "indexes" && (
          <div className="db-drawer-section">
            <div className="db-section-header">
              <span>DATABASE INDEXES & CONSTRAINTS</span>
              <span className="db-count-badge">{table.indexes.length} indexes</span>
            </div>

            {table.indexes.length === 0 ? (
              <div className="db-empty-state">No explicit secondary indexes declared.</div>
            ) : (
              <div className="db-index-list">
                {table.indexes.map((idx) => (
                  <div key={idx.name} className="db-index-card">
                    <div className="db-index-header">
                      <span className="db-index-name">{idx.name}</span>
                      {idx.unique && <span className="db-badge-unique">UNIQUE</span>}
                      {idx.type && <span className="db-badge-indextype">{idx.type}</span>}
                    </div>
                    <div className="db-index-keys">
                      Keys: {idx.keys.map((k) => (
                        <code key={k} className="db-index-key-chip">{k}</code>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

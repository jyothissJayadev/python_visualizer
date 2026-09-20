import type { DatabaseTable } from "../../lib/databaseEngine";

interface Props {
  tables: DatabaseTable[];
  selectedTableId: string | null;
  enabledTableIds: Set<string>;
  onSelectTable: (id: string) => void;
  onToggleTableEnabled: (id: string) => void;
}

export function DatabaseMatrixView({
  tables,
  selectedTableId,
  enabledTableIds,
  onSelectTable,
  onToggleTableEnabled,
}: Props) {
  return (
    <div className="db-matrix-container">
      <table className="db-matrix-table">
        <thead>
          <tr>
            <th style={{ width: 40, textAlign: "center" }}>View</th>
            <th>Database / Engine</th>
            <th>Collection / Node</th>
            <th>Domain</th>
            <th>Fields Count</th>
            <th>Primary Key</th>
            <th>Cross-DB Links</th>
            <th>Functions</th>
            <th>Endpoints</th>
            <th>Indexes</th>
          </tr>
        </thead>
        <tbody>
          {tables.map((table) => {
            const isSelected = selectedTableId === table.id;
            const isEnabled = enabledTableIds.has(table.id);
            const pk = table.fields.find((f) => f.isPrimary)?.name ?? "—";
            const crossDbField = table.fields.find(
              (f) => f.foreignTarget?.includes("neo4j:") || f.foreignTarget?.includes("mongo:")
            );
            const readCount = table.functions.filter((f) => f.op === "read").length;
            const writeCount = table.functions.filter((f) => f.op === "write").length;
            const upsertCount = table.functions.filter((f) => f.op === "upsert").length;
            const deleteCount = table.functions.filter((f) => f.op === "delete").length;
            const methods = Array.from(new Set(table.endpoints.map((e) => e.method)));

            return (
              <tr
                key={table.id}
                className={`db-matrix-row ${isSelected ? "selected" : ""} ${
                  isEnabled ? "is-enabled" : "is-disabled"
                }`}
                onClick={() => onSelectTable(table.id)}
              >
                <td style={{ textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    className="db-table-checkbox"
                    checked={isEnabled}
                    onChange={() => onToggleTableEnabled(table.id)}
                    title={isEnabled ? "Hide from view mode" : "Show in view mode"}
                  />
                </td>
                <td>
                  <span className={`db-card-engine-tag ${table.database}`}>
                    {table.database === "mongodb" ? "MongoDB" : "Neo4j"}
                  </span>
                </td>
                <td className="db-matrix-name-cell">
                  <span className="db-table-name-bold">{table.name}</span>
                  <span className="db-table-doc-sub">{table.doc}</span>
                </td>
                <td>
                  <span className="db-badge-domain">{table.domain}</span>
                </td>
                <td className="db-matrix-num-cell">
                  <code>{table.fields.length}</code>
                </td>
                <td>
                  <span className="db-key-pill pk">{pk}</span>
                </td>
                <td>
                  {crossDbField ? (
                    <span className="db-key-pill fk cross" title={crossDbField.foreignTarget}>
                      ⇄ {crossDbField.foreignTarget?.split(".")[0]}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <div className="db-matrix-ops">
                    <span className="op-count">{table.functions.length} fns</span>
                    {readCount > 0 && <span className="db-badge-op read" title={`${readCount} read`}>{readCount}R</span>}
                    {writeCount > 0 && <span className="db-badge-op write" title={`${writeCount} write`}>{writeCount}W</span>}
                    {upsertCount > 0 && <span className="db-badge-op upsert" title={`${upsertCount} upsert`}>{upsertCount}U</span>}
                    {deleteCount > 0 && <span className="db-badge-op delete" title={`${deleteCount} delete`}>{deleteCount}D</span>}
                  </div>
                </td>
                <td>
                  {table.endpoints.length > 0 ? (
                    <div
                      className="db-matrix-methods"
                      title={`${table.endpoints.length} routes:\n${table.endpoints.map((e) => `${e.method} ${e.path}`).join("\n")}`}
                    >
                      {methods.map((m) => (
                        <span key={m} className={`db-method-pill mini ${m.toLowerCase()}`}>
                          {m}
                        </span>
                      ))}
                      <span className="muted" style={{ fontSize: 10, fontFamily: "var(--font-mono)" }}>
                        ({table.endpoints.length})
                      </span>
                    </div>
                  ) : (
                    <span className="muted">None</span>
                  )}
                </td>
                <td className="db-matrix-num-cell">
                  <code>{table.indexes.length}</code>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

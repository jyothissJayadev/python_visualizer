import type { DatabaseTable } from "../../lib/databaseEngine";

interface Props {
  table: DatabaseTable;
  position: { x: number; y: number };
  selected: boolean;
  highlighted: boolean;
  dimmed: boolean;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  onMouseDown?: (e: React.MouseEvent) => void;
}

export function DatabaseTableCard({
  table,
  position,
  selected,
  highlighted,
  dimmed,
  onSelect,
  onHover,
  onMouseDown,
}: Props) {
  const isMongo = table.database === "mongodb";

  // Identify primary key and foreign keys
  const primaryField = table.fields.find((f) => f.isPrimary);
  const foreignFields = table.fields.filter((f) => f.isForeign);
  const regularFields = table.fields.filter((f) => !f.isPrimary && !f.isForeign);
  const displayedFields = [
    ...(primaryField ? [primaryField] : []),
    ...foreignFields,
    ...regularFields.slice(0, Math.max(1, 4 - foreignFields.length)),
  ].slice(0, 5);

  const remainingCount = table.fields.length - displayedFields.length;

  const readFns = table.functions.filter((f) => f.op === "read").length;
  const writeFns = table.functions.filter((f) => f.op === "write").length;
  const upsertFns = table.functions.filter((f) => f.op === "upsert").length;
  const deleteFns = table.functions.filter((f) => f.op === "delete").length;

  const methods = Array.from(new Set(table.endpoints.map((e) => e.method)));

  const hasCrossDbRef = table.fields.some(
    (f) => f.foreignTarget && (f.foreignTarget.includes("neo4j:") || f.foreignTarget.includes("mongo:"))
  );

  return (
    <div
      className={`db-table-card db-theme-${table.database} ${selected ? "selected" : ""} ${
        highlighted ? "highlighted" : ""
      } ${dimmed ? "dimmed" : ""}`}
      style={{
        transform: `translate(${position.x}px, ${position.y}px)`,
      }}
      onClick={() => onSelect(table.id)}
      onMouseDown={onMouseDown}
      onMouseEnter={() => onHover(table.id)}
      onMouseLeave={() => onHover(null)}
      data-table-id={table.id}
    >
      <div className="db-card-header">
        <div className="db-card-title-row">
          <div className="db-card-icon" title={isMongo ? "MongoDB Collection" : "Neo4j Graph Node"}>
            {isMongo ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2C8 6 6 10 6 14c0 3.3 2.7 6 6 6s6-2.7 6-6c0-4-2-8-6-12z" />
                <path d="M12 2v18" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="6" cy="6" r="3" />
                <circle cx="18" cy="18" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M6 9v6M9 6h6M8 16l8-8" />
              </svg>
            )}
          </div>
          <span className="db-card-name" title={table.name}>
            {table.name}
          </span>
          <span className={`db-card-engine-tag ${table.database}`}>
            {isMongo ? "mongo" : "neo4j"}
          </span>
        </div>

        <div className="db-card-badges">
          <span className="db-badge-domain" title={`Domain: ${table.domain}`}>
            {table.domain}
          </span>
          {hasCrossDbRef && (
            <span className="db-badge-cross" title="Contains Cross-Database foreign link">
              ⇄ cross-db
            </span>
          )}
          {table.type === "graph_node" && (
            <span className="db-badge-graph" title="Graph Node Type">
              graph
            </span>
          )}
        </div>
      </div>

      <div className="db-card-fields">
        {displayedFields.map((field) => (
          <div key={field.name} className="db-card-field-row">
            <span className="db-field-name">
              {field.isPrimary && <span className="db-key-pill pk" title="Primary Key">PK</span>}
              {field.isForeign && <span className="db-key-pill fk" title={`Foreign Key -> ${field.foreignTarget ?? ""}`}>FK</span>}
              {field.name}
            </span>
            <span className="db-field-type" title={field.type}>{field.type}</span>
          </div>
        ))}

        {remainingCount > 0 && (
          <div className="db-card-more-fields">
            +{remainingCount} more field{remainingCount > 1 ? "s" : ""}
          </div>
        )}
      </div>

      <div className="db-card-footer">
        <div
          className="db-footer-metric"
          title={`${table.functions.length} functions: ${readFns}R, ${writeFns}W, ${upsertFns}U, ${deleteFns}D`}
        >
          <span className="db-glyph-fn">ƒ</span>
          <span>{table.functions.length}</span>
          {readFns > 0 && <span className="db-badge-op read" title={`${readFns} read ops`}>R</span>}
          {writeFns > 0 && <span className="db-badge-op write" title={`${writeFns} write ops`}>W</span>}
          {upsertFns > 0 && <span className="db-badge-op upsert" title={`${upsertFns} upsert ops`}>U</span>}
          {deleteFns > 0 && <span className="db-badge-op delete" title={`${deleteFns} delete ops`}>D</span>}
        </div>

        {table.endpoints.length > 0 && (
          <div
            className="db-footer-ep-group"
            title={`${table.endpoints.length} endpoints calling this table:\n${table.endpoints.map((e) => `${e.method} ${e.path}`).join("\n")}`}
          >
            <span className="db-glyph-ep">⇄</span>
            <div className="db-card-method-pills">
              {methods.map((m) => (
                <span key={m} className={`db-card-method-pill ${m.toLowerCase()}`}>
                  {m}
                </span>
              ))}
            </div>
          </div>
        )}

        {table.indexes.length > 0 && (
          <div className="db-footer-metric" title={`${table.indexes.length} database indexes`}>
            <span className="db-glyph-idx">⚡</span>
            <span>{table.indexes.length}</span>
          </div>
        )}
      </div>
    </div>
  );
}

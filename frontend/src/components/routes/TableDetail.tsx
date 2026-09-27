import { routesStore } from "../../lib/routesStore";
import { useRoutes } from "../../lib/useRoutes";
import { OP_LABEL, displayTable, isDocumented, openInDatabaseView, relationsOf, shortTable, tableLabel } from "../../lib/routesData";
import type { TableOp } from "../../lib/routesApi";
import { useDatabase } from "../../lib/useDatabase";

const OPS: TableOp[] = ["read", "write", "upsert", "delete"];

/** Right-hand panel of the Data tab: one table, what this endpoint does to it,
    which functions do it, and (when documented) its fields and relationships. */
export function TableDetail() {
  const s = useRoutes();
  const allRelations = useDatabase().schema.relationships;
  const usage = s.data?.tables.find((t) => t.table === s.selectedTable);

  if (!s.data) {
    return (
      <aside className="rt-drawer">
        <div className="rt-drawer-head">
          <span className="rt-drawer-title">Database</span>
          <span className="rt-spacer" />
          <button className="rt-icon-btn" title="Close details panel" onClick={() => routesStore.setDrawerOpen(false)}>✕</button>
        </div>
        <div className="rt-drawer-empty">Loading…</div>
      </aside>
    );
  }

  if (!usage) {
    return (
      <aside className="rt-drawer">
        <div className="rt-drawer-head">
          <span className="rt-drawer-title">Database</span>
          <span className="rt-spacer" />
          <button className="rt-icon-btn" title="Close details panel" onClick={() => routesStore.setDrawerOpen(false)}>✕</button>
        </div>
        <div className="rt-drawer-body">
          <p className="rt-note hint">Select a table to see which functions read or write it, and to jump to them in the hierarchy.</p>
          <div className="rt-field-label">Most used tables</div>
          <ul className="rt-table-list">
            {s.data.tables.slice(0, 8).map((t) => (
              <li key={t.table}>
                <button onClick={() => routesStore.setSelectedTable(t.table)}>
                  <code>{tableLabel(t.table)}</code>
                  <span className="rt-count">{t.functions.length} fn</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    );
  }

  const table = displayTable(usage);
  const documented = isDocumented(usage.table);
  const relations = relationsOf(usage.table, allRelations);
  const byOp = OPS.map((op) => ({ op, fns: usage.functions.filter((f) => f.op === op) })).filter((g) => g.fns.length);

  return (
    <aside className="rt-drawer">
      <div className="rt-drawer-head">
        <span className={"db-card-engine-tag " + usage.database}>{usage.database === "mongodb" ? "Mongo" : "Neo4j"}</span>
        <div className="rt-drawer-titles">
          <div className="rt-drawer-kind">{usage.database === "mongodb" ? "collection" : "graph node label"}</div>
          <div className="rt-drawer-title mono" title={usage.table}>{usage.name}</div>
        </div>
        <button className="rt-icon-btn" title="Back to the table list" onClick={() => routesStore.setSelectedTable(null)}>←</button>
        <button className="rt-icon-btn" title="Close details panel" onClick={() => routesStore.setDrawerOpen(false)}>✕</button>
      </div>
      <div className="rt-drawer-body">
        <div className="rt-op-summary">
          {OPS.filter((o) => usage.ops[o]).map((o) => (
            <span key={o} className={"rt-op op-" + o}>{OP_LABEL[o]} <b>{usage.ops[o]}</b></span>
          ))}
        </div>

        {usage.uncertain && (
          <p className="rt-note warn">
            Only one of several possible labels: at least one query names this table through a value chosen at
            runtime (for example a label picked by domain). Functions marked ≈ may touch a different one.
          </p>
        )}
        {!documented && (
          <p className="rt-note warn">
            Found in the code, but not described in the Database view's schema — no field list or relationships are available.
          </p>
        )}
        {table.doc && <p className="rt-doc-block">{table.doc}</p>}

        {byOp.map(({ op, fns }) => (
          <div key={op} className="rt-table-fns">
            <div className="rt-field-label">Functions that {OP_LABEL[op]} it · {fns.length}</div>
            <ul>
              {fns.map((f) => (
                <li key={f.path + op}>
                  <button className="rt-fn-link" title="Show in the hierarchy" onClick={() => void routesStore.revealNode(f.path)}>
                    <span className="rt-glyph k-function">ƒ</span>
                    <code>{f.name}</code>
                    {f.uncertain && <span className="rt-uncertain" title="Could be a different label at runtime">≈</span>}
                    {f.count > 1 && <span className="rt-count">×{f.count}</span>}
                    <span className="rt-fn-go">show ›</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}

        {relations.length > 0 && (
          <div>
            <div className="rt-field-label">Relationships · {relations.length}</div>
            <ul className="rt-rel-list">
              {relations.map((r) => {
                const other = r.fromTableId === usage.table ? r.toTableId : r.fromTableId;
                const inEndpoint = s.data!.tables.some((t) => t.table === other);
                return (
                  <li key={r.id}>
                    <span className="rt-rel-arrow">{r.fromTableId === usage.table ? "→" : "←"}</span>
                    <button
                      disabled={!inEndpoint}
                      title={inEndpoint ? "Select this table" : "Not touched by this endpoint"}
                      onClick={() => routesStore.setSelectedTable(other)}
                    >
                      <code>{shortTable(other)}</code>
                    </button>
                    <span className="muted">{r.label}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {table.fields.length > 0 && (
          <div>
            <div className="rt-field-label">Fields · {table.fields.length}</div>
            <ul className="rt-fields">
              {table.fields.map((f) => (
                <li key={f.name} title={f.doc}>
                  <span>
                    {f.isPrimary && <span className="db-key-pill pk">PK</span>}
                    {f.isForeign && <span className="db-key-pill fk">FK</span>}
                    <code>{f.name}</code>
                  </span>
                  <span className="muted">{f.type}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {documented && (
          <div className="rt-drawer-actions">
            <button className="rt-btn" onClick={() => openInDatabaseView(usage.table)}>Open in Database view ›</button>
          </div>
        )}
      </div>
    </aside>
  );
}

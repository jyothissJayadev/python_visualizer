import { useState } from "react";
import type { SchemaAudit } from "../../lib/databaseCode";

interface Props {
  audit: SchemaAudit | null;
  state: "idle" | "loading" | "ready" | "error";
  error: string | null;
  onSelectTable: (id: string) => void;
}

/** How the documented schema and brain's code compare — so nothing is silently
    stale: tables the code uses that nobody documented, and documented tables
    the code never touches. Function / endpoint links are derived, not written. */
export function SchemaAuditPanel({ audit, state, error, onSelectTable }: Props) {
  const [open, setOpen] = useState(false);

  if (state === "error") {
    return (
      <div className="db-audit warn">
        <b>Code analysis unavailable</b>
        <span>{error} — showing only the documented schema, without function or endpoint links.</span>
      </div>
    );
  }
  if (!audit) return <div className="db-audit">{state === "loading" ? "Reading brain's code…" : ""}</div>;

  const undocumented = audit.undocumented.length;
  const unused = audit.documentedUnused.length;
  return (
    <div className={"db-audit" + (undocumented + unused > 0 ? " attention" : "")}>
      <button type="button" className="db-audit-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="db-audit-title">Schema audit</span>
        <span className="db-audit-sum">
          <b>{audit.codeTables}</b> in code · <b>{audit.documentedTables}</b> documented
        </span>
        {undocumented > 0 && <span className="db-audit-chip warn" title="Used by the code, not described in the schema">{undocumented} undocumented</span>}
        {unused > 0 && <span className="db-audit-chip" title="Described in the schema, never touched by any function">{unused} unused</span>}
        <span className={"db-audit-caret" + (open ? " open" : "")}>▸</span>
      </button>
      {open && (
        <div className="db-audit-body">
          <p className="db-audit-note">
            Which functions and endpoints use a table comes from the code (analysis #{audit.generation}), not from the
            schema. Fields marked <i>Inferred</i> come from models and from what the code writes and queries.
          </p>
          {undocumented > 0 && (
            <section>
              <h4>In the code, not documented · {undocumented}</h4>
              <ul>
                {audit.undocumented.map((t) => (
                  <li key={t.id}>
                    <button type="button" onClick={() => onSelectTable(t.id)}>
                      <code>{t.name}</code>
                      <span>{t.fields} fields inferred</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {unused > 0 && (
            <section>
              <h4>Documented, never touched by the code · {unused}</h4>
              <ul>
                {audit.documentedUnused.map((t) => (
                  <li key={t.id}>
                    <button type="button" onClick={() => onSelectTable(t.id)}>
                      <code>{t.name}</code>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {undocumented + unused === 0 && <p className="db-audit-note">The schema and the code agree.</p>}
        </div>
      )}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { routesStore } from "../../lib/routesStore";
import { useRoutes } from "../../lib/useRoutes";
import { displayTable, isDocumented, isRelationship, relationsAmong } from "../../lib/routesData";
import { DatabaseTableCard } from "../database/DatabaseTableCard";
import type { DatabaseTable } from "../../lib/databaseEngine";
import type { DataAudit } from "../../lib/routesApi";

const CARD_W = 260;
const GAP_X = 30;
const GAP_Y = 30;
const PAD = 28;
const HEADING_H = 34;

/** Card height (header + up to 5 field rows + footer), measured from the
    rendered cards: ~104px bare, +~21px per field row, +~22px for "+N more". */
function cardHeight(t: DatabaseTable): number {
  const rows = Math.min(5, t.fields.length);
  return 108 + rows * 21 + (t.fields.length > 5 ? 22 : 0) + (rows > 0 ? 6 : 0);
}

type DbFilter = "all" | "mongodb" | "neo4j";

/** Coverage: how completely the endpoint's database access was tied to tables,
    and exactly which functions were not (so nothing is silently missing). */
function AuditBar({ audit }: { audit: DataAudit }) {
  const [open, setOpen] = useState(false);
  if (audit.functions === 0) return null;
  const bad = audit.unmatched.length;
  const pct = Math.round((100 * audit.matched) / audit.functions);
  return (
    <div className={"rt-audit" + (bad ? " warn" : "")}>
      <div className="rt-audit-head">
        <span className="rt-cov-bar"><span style={{ width: `${pct}%` }} className={bad ? "low" : ""} /></span>
        <span><b>{audit.matched}</b> of <b>{audit.functions}</b> database-touching functions matched to a table</span>
        {bad > 0 && (
          <button className="rt-btn sm" onClick={() => setOpen((o) => !o)}>{open ? "Hide" : `${bad} not matched`}</button>
        )}
      </div>
      {open && (
        <ul className="rt-audit-list">
          {audit.unmatched.map((u, i) => (
            <li key={u.path + i}>
              <button className="rt-fn-link" onClick={() => void routesStore.revealNode(u.path)} title="Show in the hierarchy">
                <span className="rt-glyph k-function">ƒ</span>
                <code>{u.name}</code>
                <span className="rt-op op-unknown">{u.via ? `${u.via}()` : "dynamic"}</span>
                <span className="muted rt-audit-reason">{u.reason ?? ""}{u.line ? ` · line ${u.line}` : ""}</span>
                <span className="rt-fn-go">show ›</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The tables an endpoint touches, drawn as an ER-style diagram with the
    Database view's own cards. Tables the code analysis found but the schema
    does not describe are shown too (marked "not in schema"). */
export function EndpointData() {
  const s = useRoutes();
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(820);
  const [filter, setFilter] = useState<DbFilter>("all");
  const [query, setQuery] = useState("");
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const usage = s.data?.tables;
  const tables = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (usage ?? [])
      .filter((t) => (filter === "all" || t.database === filter) && (!needle || t.table.toLowerCase().includes(needle)))
      .map((t) => displayTable(t));
  }, [usage, filter, query]);

  const layout = useMemo(() => {
    const cols = Math.max(1, Math.floor((width - 2 * PAD + GAP_X) / (CARD_W + GAP_X)));
    const positions = new Map<string, { x: number; y: number; h: number }>();
    const headings: { y: number; label: string }[] = [];
    let y = PAD;
    const sections: [string, (t: DatabaseTable) => boolean][] = [
      ["MongoDB collections", (t) => t.database === "mongodb"],
      ["Neo4j node labels", (t) => t.database === "neo4j" && !isRelationship(t.id)],
      ["Neo4j relationship types", (t) => isRelationship(t.id)],
    ];
    for (const [label, pick] of sections) {
      const group = tables.filter(pick);
      if (!group.length) continue;
      headings.push({ y, label: `${label} · ${group.length}` });
      y += HEADING_H;
      // masonry: each card goes into the currently shortest column, so short
      // (undocumented) cards do not leave tall empty rows behind them
      const colY = Array.from({ length: cols }, () => y);
      for (const t of group) {
        const c = colY.indexOf(Math.min(...colY));
        const h = cardHeight(t);
        positions.set(t.id, { x: PAD + c * (CARD_W + GAP_X), y: colY[c], h });
        colY[c] += h + GAP_Y;
      }
      y = Math.max(...colY);
    }
    return { positions, headings, height: y + PAD };
  }, [tables, width]);

  const relations = useMemo(() => relationsAmong(new Set(tables.map((t) => t.id))), [tables]);
  const related = useMemo(() => {
    const out = new Set<string>();
    if (hover) {
      out.add(hover);
      for (const r of relations) {
        if (r.fromTableId === hover) out.add(r.toTableId);
        if (r.toTableId === hover) out.add(r.fromTableId);
      }
    }
    return out;
  }, [hover, relations]);

  const total = usage?.length ?? 0;
  const mongo = usage?.filter((t) => t.database === "mongodb").length ?? 0;
  const undocumented = usage?.filter((t) => !isDocumented(t.table)).length ?? 0;
  const uncertainIds = useMemo(() => new Set((usage ?? []).filter((t) => t.uncertain).map((t) => t.table)), [usage]);

  if (!s.data) {
    return <div className="rt-state"><span className="rt-spinner big" /> Finding the database tables this endpoint touches…</div>;
  }
  if (total === 0) {
    return (
      <div className="rt-state rt-state-col">
        <div className="rt-empty-icon">▤</div>
        <b>No database access found</b>
        <span>None of the functions in this endpoint's hierarchy read or write a MongoDB collection, Beanie document or Neo4j label that can be traced statically.</span>
      </div>
    );
  }

  return (
    <div className="rt-er">
      <div className="rt-er-bar">
        <span className="rt-er-summary">
          <b>{total}</b> table{total > 1 ? "s" : ""} · {mongo} MongoDB · {total - mongo} Neo4j
          {undocumented > 0 && <span className="rt-mini warn" title="Found in the code, but not described in the Database view's schema">{undocumented} not in schema</span>}
          {uncertainIds.size > 0 && <span className="rt-mini warn" title="Only one of several possible labels — chosen at runtime, e.g. by domain">{uncertainIds.size} one-of</span>}
        </span>
        <span className="rt-spacer" />
        <input className="rt-input rt-er-search" placeholder="Filter tables…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="rt-seg">
          {(["all", "mongodb", "neo4j"] as const).map((f) => (
            <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f === "mongodb" ? "Mongo" : "Neo4j"}
            </button>
          ))}
        </div>
      </div>

      <AuditBar audit={s.data.audit} />

      <div className="rt-er-scroll" ref={wrap}>
        <div className="rt-er-stage" style={{ height: layout.height }}>
          {layout.headings.map((h) => (
            <div key={h.label} className="rt-er-heading" style={{ top: h.y, left: PAD }}>{h.label}</div>
          ))}
          <svg className="rt-er-edges" height={layout.height}>
            {relations.map((r) => {
              const a = layout.positions.get(r.fromTableId);
              const b = layout.positions.get(r.toTableId);
              if (!a || !b) return null;
              const x1 = a.x + CARD_W / 2, y1 = a.y + a.h / 2, x2 = b.x + CARD_W / 2, y2 = b.y + b.h / 2;
              const dim = hover && !(related.has(r.fromTableId) && related.has(r.toTableId));
              return (
                <g key={r.id} className={"rt-er-edge " + r.type + (dim ? " dim" : "")}>
                  <path d={`M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`} />
                  <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 4}>{r.label}</text>
                </g>
              );
            })}
          </svg>
          {tables.map((t) => {
            const pos = layout.positions.get(t.id);
            if (!pos) return null;
            return (
              <div key={t.id} className={"rt-er-card" + (isDocumented(t.id) ? "" : " undocumented") + (uncertainIds.has(t.id) ? " uncertain" : "")}>
                {uncertainIds.has(t.id) && <span className="rt-er-flag" style={{ left: pos.x + 12, top: pos.y - 9 }}>one of several labels</span>}
                <DatabaseTableCard
                  table={t}
                  position={{ x: pos.x, y: pos.y }}
                  selected={s.selectedTable === t.id}
                  highlighted={hover !== null && related.has(t.id) && hover !== t.id}
                  dimmed={hover !== null && !related.has(t.id)}
                  onSelect={(id) => routesStore.setSelectedTable(s.selectedTable === id ? null : id)}
                  onHover={setHover}
                />
              </div>
            );
          })}
          {tables.length === 0 && <div className="rt-er-none">No tables match the filter.</div>}
        </div>
      </div>
    </div>
  );
}

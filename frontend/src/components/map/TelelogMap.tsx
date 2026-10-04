/* TelelogMap — the human-meaning view of the project (docs/designs/telelog.md).
   Four levels you drill through, not zoom through: Project (features) -> Feature (flows) ->
   Flow (ordered steps, edges labelled with the data passed) -> Function (helpers).
   Click selects (detail panel), double-click or Enter drills in, Esc goes up, arrows move
   between nodes, "/" searches. Layout is pure data (lib/telelogLayout.ts). */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { telelogApi, type LiveField, type LiveValues, type TagField, type TelelogFn, type TelelogMapData } from "../../lib/mapApi";
import { edgePath, type Box } from "../../lib/mapLayout";
import {
  buildLevel, clip, crumbs, levelOf, matchesFilter, parentLevel, shortName,
  type Health, type Level, type LNode,
} from "../../lib/telelogLayout";
import { useRoutesValue } from "../../lib/useRoutes";

type Mode = "telelog" | "deterministic";
interface View { x: number; y: number; k: number }

export function ViewSwitch({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="tl-switch" role="group" aria-label="Map view">
      {(["telelog", "deterministic"] as const).map((m) => (
        <button key={m} type="button" aria-pressed={mode === m} className={mode === m ? "on" : ""} onClick={() => onChange(m)}>
          {m === "telelog" ? "Telelog" : "Deterministic"}
        </button>
      ))}
    </div>
  );
}

function LiveCell({ field }: { field: LiveField | undefined }) {
  if (!field) return <span className="tl-val tl-val-none" />;
  if (field.state === "redacted") return <span className="tl-val tl-val-redacted">redacted</span>;
  if (field.state === "no-sample") return <span className="tl-val tl-val-none">no sample</span>;
  return <code className="tl-val">{field.value}</code>;
}

function FieldTable({ title, fields, live }: { title: string; fields: TagField[] | null; live: Record<string, LiveField> | undefined }) {
  return (
    <>
      <h4>{title}</h4>
      {!fields || fields.length === 0 ? (
        <div className="muted">none declared</div>
      ) : (
        <table className="tl-fields">
          <tbody>
            {fields.map((f) => (
              <tr key={f.name}>
                <td className="tl-fname">{f.name}{f.optional ? "?" : ""}</td>
                <td className="tl-fsrc">{f.source ?? ""}</td>
                <td><LiveCell field={live?.[f.name]} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function StatusBadge({ health }: { health: Health }) {
  if (health === "ok") return <span className="tl-health tl-health-ok">tag ok</span>;
  const text = health === "untagged" ? "untagged" : health;
  const title =
    health === "stale" ? "function body changed since the tag was last verified"
    : health === "invalid" ? "the tag has errors; see below"
    : "no @telelog tag yet";
  return <span className={`tl-health tl-health-${health}`} title={title}>{text}</span>;
}

function Panel({ id, data, live, onJump, onClose }: {
  id: string; data: TelelogMapData; live: LiveValues | null; onJump: (id: string) => void; onClose: () => void;
}) {
  const fn: TelelogFn | undefined = data.functions[id];
  return (
    <aside className="mp-detail tl-detail" aria-label="Function details">
      <div className="mp-detail-head">
        <div>
          <div className="mp-detail-name">{shortName(id)}</div>
          <div className="mp-detail-id">{id}</div>
        </div>
        <button type="button" className="btn-icon" onClick={onClose} title="Close (Esc)" aria-label="Close details">✕</button>
      </div>
      {!fn ? (
        <>
          <div className="mp-detail-meta"><StatusBadge health="untagged" /></div>
          <p className="tl-note">Untagged. Run <code>/telelog</code> in Claude Code to add its tag.</p>
        </>
      ) : (
        <>
          <div className="mp-detail-meta">
            {fn.role && <span className={`tl-role tl-role-${fn.role}`}>{fn.role}</span>}
            {fn.feature && <span className="mp-chip">{fn.feature}</span>}
            <StatusBadge health={fn.status} />
          </div>
          <p className="mp-purpose">{fn.purpose && fn.purpose !== "?" ? fn.purpose : <span className="muted">No purpose written yet.</span>}</p>
          {fn.parent && (
            <div className="tl-parent">
              parent <button type="button" className="mp-link" onClick={() => onJump(fn.parent!)}>{shortName(fn.parent)}</button>
              {fn.n != null && <span className="mp-line"> step {fn.n}</span>}
            </div>
          )}
          {fn.problems.length > 0 && (
            <ul className="tl-problems">{fn.problems.map((p) => <li key={`${p.code}${p.line}`}>L{p.line}: {p.message}</li>)}</ul>
          )}
          {live && live.status === "no-trace" && (fn.inputs?.length || fn.outputs?.length) ? (
            <p className="tl-note">
              No trace yet. Arm this function in{" "}
              <button type="button" className="mp-link" onClick={() => { window.location.hash = "#/terminal"; }}>Terminal</button>{" "}
              and send a request.
            </p>
          ) : null}
          <FieldTable title="Incoming data" fields={fn.inputs} live={live?.inputs} />
          <FieldTable title="Outgoing data" fields={fn.outputs} live={live?.outputs} />
          <h4>Database</h4>
          {fn.db && fn.db.length ? (
            <div className="mp-chips">{fn.db.map((d) => <span key={d.table} className="mp-chip">{d.table} ({d.mode})</span>)}</div>
          ) : <div className="muted">none declared</div>}
          {fn.role === "main" && fn.algo && fn.algo.length > 0 && (
            <>
              <h4>Algorithm</h4>
              <ol className="tl-algo">{fn.algo.map((a, i) => <li key={i}>{a}</li>)}</ol>
            </>
          )}
        </>
      )}
    </aside>
  );
}

export function TelelogMap({ active, onSwitch }: { active: boolean; onSwitch: () => void }) {
  const [data, setData] = useState<TelelogMapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<Level>({ kind: "project" });
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Health | "all">("all");
  const [liveFor, setLive] = useState<{ id: string; values: LiveValues } | null>(null);
  const [view, setView] = useState<View>({ x: 20, y: 90, k: 1 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const generation = useRoutesValue((s) => s.analysis?.generation ?? 0);

  const load = useCallback(async () => {
    try {
      setError(null);
      setData(await telelogApi.map());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // the backend re-analyses on every code change; reload so an audit shows up as it happens
  useEffect(() => {
    if (active) void load();
  }, [active, generation, load]);

  const lv = useMemo(() => (data ? buildLevel(level, data) : null), [data, level]);

  const fit = useCallback(() => {
    const el = wrapRef.current;
    if (!el || !lv) return;
    const k = Math.max(0.35, Math.min(1, (el.clientWidth - 60) / (lv.bounds.w + 40), (el.clientHeight - 150) / (lv.bounds.h + 40)));
    setView({ k, x: Math.max(20, (el.clientWidth - lv.bounds.w * k) / 2), y: 96 });
  }, [lv]);

  useEffect(() => {
    if (active) fit();
  }, [fit, active]);

  // newest traced values for the selected function
  useEffect(() => {
    if (!selected || !data?.functions[selected]) return;
    let alive = true;
    telelogApi.live(selected).then((values) => alive && setLive({ id: selected, values })).catch(() => undefined);
    return () => { alive = false; };
  }, [selected, data]);
  const live = liveFor && liveFor.id === selected ? liveFor.values : null;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      setView((v) => {
        const k = Math.min(2.5, Math.max(0.2, v.k * Math.exp(-ev.deltaY * 0.0015)));
        const r = k / v.k;
        return { k, x: px - (px - v.x) * r, y: py - (py - v.y) * r };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const go = useCallback((next: Level) => {
    setLevel(next);
    setSelected(null);
  }, []);

  const up = useCallback(() => {
    if (data) go(parentLevel(level, data));
  }, [data, level, go]);

  const jump = useCallback((id: string) => {
    if (!data) return;
    setLevel(levelOf(id, data));
    setSelected(id);
    setQuery("");
  }, [data]);

  const open = (n: LNode) => {
    if (n.drill) go(n.drill);
    else if (n.fn) setSelected(n.fn);
  };
  const pick = (n: LNode) => {
    if (suppressClick.current) return;
    if (n.fn) setSelected(n.fn);
    else if (n.drill) go(n.drill);
  };

  const onKeyDown = (ev: React.KeyboardEvent) => {
    const target = ev.target as HTMLElement;
    const typing = target.tagName === "INPUT";
    if (ev.key === "Escape") {
      if (typing) { setQuery(""); (target as HTMLInputElement).blur(); return; }
      if (selected) setSelected(null);
      else if (level.kind !== "project") up();
      return;
    }
    if (typing) return;
    if (ev.key === "/") {
      ev.preventDefault();
      searchRef.current?.focus();
      return;
    }
    const nid = target.getAttribute?.("data-nid");
    if (!nid || !lv) return;
    const idx = lv.nodes.findIndex((n) => n.id === nid);
    const node = lv.nodes[idx];
    if ((ev.key === "Enter" || ev.key === " ") && node) {
      ev.preventDefault();
      open(node);
    } else if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(ev.key)) {
      ev.preventDefault();
      const step = ev.key === "ArrowRight" || ev.key === "ArrowDown" ? 1 : -1;
      const next = lv.nodes[(idx + step + lv.nodes.length) % lv.nodes.length];
      wrapRef.current?.querySelector<SVGGElement>(`[data-nid="${CSS.escape(next.id)}"]`)?.focus();
    }
  };

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !data) return [];
    const ids = [...Object.keys(data.functions), ...Object.values(data.untagged).flat()];
    return ids.filter((id) => id.toLowerCase().includes(q)).slice(0, 8);
  }, [query, data]);

  const nodeById = useMemo(() => new Map((lv?.nodes ?? []).map((n) => [n.id, n])), [lv]);
  const crumbList = useMemo(() => (data ? crumbs(level, data) : []), [data, level]);
  const cov = data?.coverage;

  const zoomBy = (f: number) => {
    const el = wrapRef.current;
    if (!el) return;
    setView((v) => {
      const k = Math.min(2.5, Math.max(0.2, v.k * f));
      const r = k / v.k;
      return { k, x: el.clientWidth / 2 - (el.clientWidth / 2 - v.x) * r, y: el.clientHeight / 2 - (el.clientHeight / 2 - v.y) * r };
    });
  };

  const labelAt = (a: Box, b: Box): { x: number; y: number } => {
    const ax = a.x + a.w;
    const ay = a.y + a.h / 2;
    const horizontal = b.x > ax;
    return horizontal
      ? { x: (ax + b.x) / 2, y: (ay + b.y + b.h / 2) / 2 - 8 }
      : { x: (a.x + a.w / 2 + b.x + b.w / 2) / 2, y: (a.y + a.h + b.y) / 2 - 4 };
  };
  const edgeGeometry = (a: Box, b: Box): string => {
    if (b.x > a.x + a.w) return edgePath(a, b);
    const ax = a.x + a.w / 2;
    const ay = a.y + a.h;
    const bx = b.x + b.w / 2;
    return `M${ax},${ay} C${ax},${ay + 50} ${bx},${b.y - 50} ${bx},${b.y}`;
  };

  return (
    <div className="mp-workspace" onKeyDown={onKeyDown}>
      <div className="mp-canvas-wrap tl-canvas" ref={wrapRef}>
        <div className="mp-toolbar tl-toolbar">
          <ViewSwitch mode="telelog" onChange={(m) => m === "deterministic" && onSwitch()} />
          <nav className="tl-crumbs" aria-label="Breadcrumb">
            {crumbList.map((c, i) => (
              <span key={`${i}${c.label}`}>
                {i > 0 && <span className="tl-sep" aria-hidden="true"> › </span>}
                {i === crumbList.length - 1 ? (
                  <span aria-current="page" className="tl-crumb-now">{clip(c.label, 28)}</span>
                ) : (
                  <button type="button" className="mp-link" onClick={() => go(c.level)}>{clip(c.label, 28)}</button>
                )}
              </span>
            ))}
          </nav>
          <div className="mp-search">
            <input
              ref={searchRef}
              className="rt-input"
              placeholder="Find a function…  ( / )"
              aria-label="Find a function"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {matches.length > 0 && (
              <ul className="mp-search-results">
                {matches.map((id) => (
                  <li key={id}>
                    <button type="button" onClick={() => jump(id)}>{id}</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {cov && (
            <span className="tl-chips" role="group" aria-label="Tag coverage">
              <button type="button" className={`tl-chip ${filter === "untagged" ? "on" : ""}`} aria-pressed={filter === "untagged"}
                onClick={() => setFilter(filter === "untagged" ? "all" : "untagged")} title="Show untagged functions">
                {cov.tagged}/{cov.total} tagged
              </button>
              {cov.stale > 0 && (
                <button type="button" className={`tl-chip tl-chip-stale ${filter === "stale" ? "on" : ""}`} aria-pressed={filter === "stale"}
                  onClick={() => setFilter(filter === "stale" ? "all" : "stale")}>{cov.stale} stale</button>
              )}
              {cov.invalid > 0 && (
                <button type="button" className={`tl-chip tl-chip-invalid ${filter === "invalid" ? "on" : ""}`} aria-pressed={filter === "invalid"}
                  onClick={() => setFilter(filter === "invalid" ? "all" : "invalid")}>{cov.invalid} invalid</button>
              )}
            </span>
          )}
          <span className="rt-spacer" />
          <button type="button" className="btn-icon" onClick={() => zoomBy(1.3)} title="Zoom in" aria-label="Zoom in">＋</button>
          <button type="button" className="btn-icon" onClick={() => zoomBy(1 / 1.3)} title="Zoom out" aria-label="Zoom out">－</button>
          <button type="button" className="btn-icon" onClick={fit} title="Fit this level" aria-label="Fit this level">⤢</button>
          <button type="button" className="btn-icon" onClick={() => void load()} title="Reload" aria-label="Reload">↻</button>
        </div>

        {cov && cov.tagged === 0 && (
          <div className="tl-banner" role="status">
            No telelog tags yet. Run <code>/telelog</code> in Claude Code.
            <button type="button" className="btn-sm" onClick={onSwitch}>Open Deterministic view</button>
          </div>
        )}
        {error && <div className="mp-empty">Telelog map not available: {error}. The analysis may still be running.</div>}
        {!error && !data && <div className="mp-empty">Loading map…</div>}
        {lv?.empty && <div className="mp-empty">{lv.empty}</div>}

        {lv && (
          <svg
            className="mp-svg"
            role="group"
            aria-label={`Telelog map, ${crumbList[crumbList.length - 1]?.label ?? "Project"}`}
            onPointerDown={(ev) => {
              drag.current = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y, moved: false };
              (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
            }}
            onPointerMove={(ev) => {
              const d = drag.current;
              if (!d) return;
              const dx = ev.clientX - d.x;
              const dy = ev.clientY - d.y;
              if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
              if (d.moved) setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
            }}
            onPointerUp={() => {
              if (drag.current?.moved) {
                suppressClick.current = true;
                setTimeout(() => { suppressClick.current = false; }, 0);
              }
              drag.current = null;
            }}
            onClick={() => { if (!suppressClick.current) setSelected(null); }}
          >
            <defs>
              <marker id="tl-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" className="mp-arrow" />
              </marker>
            </defs>
            <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              {lv.groups.map((g, i) => (
                <rect key={i} x={g.x} y={g.y} width={g.w} height={g.h} rx={12} className="tl-group" />
              ))}
              {lv.edges.map((e) => {
                const a = nodeById.get(e.from);
                const b = nodeById.get(e.to);
                if (!a || !b) return null;
                const mid = labelAt(a.box, b.box);
                return (
                  <g key={`${e.from}>${e.to}`}>
                    <path d={edgeGeometry(a.box, b.box)} className="mp-edge" markerEnd="url(#tl-arrow)" />
                    {e.label && (
                      <g className="tl-edge-label">
                        <title>{e.title ?? e.label}</title>
                        <rect x={mid.x - (e.label.length * 3.4 + 7)} y={mid.y - 9} width={e.label.length * 6.8 + 14} height={18} rx={9} />
                        <text x={mid.x} y={mid.y + 4} textAnchor="middle">{e.label}</text>
                      </g>
                    )}
                  </g>
                );
              })}
              {lv.nodes.map((n) => {
                const dim = filter !== "all" && !matchesFilter(n.health, filter);
                const isSel = n.fn != null && n.fn === selected;
                const compact = n.kind === "helper" || n.kind === "table" || n.kind === "external";
                return (
                  <g
                    key={n.id}
                    data-nid={n.id}
                    tabIndex={0}
                    role="button"
                    aria-label={n.aria}
                    aria-pressed={n.fn ? isSel : undefined}
                    className={`tl-node tl-${n.kind} tl-h-${n.health} ${isSel ? "selected" : ""} ${dim ? "dim" : ""}`}
                    onClick={(ev) => { ev.stopPropagation(); pick(n); }}
                    onDoubleClick={(ev) => { ev.stopPropagation(); open(n); }}
                  >
                    <rect x={n.box.x} y={n.box.y} width={n.box.w} height={n.box.h} rx={compact ? n.box.h / 2 : 9} />
                    <text x={n.box.x + (compact ? 14 : 12)} y={n.box.y + (compact ? n.box.h / 2 + 4 : 24)} className="tl-label">
                      {n.kind === "table" ? "table " : n.kind === "external" ? "ext " : ""}{clip(n.label, compact ? 22 : 24)}
                    </text>
                    {!compact && n.sub && <text x={n.box.x + 12} y={n.box.y + 44} className="tl-sub">{clip(n.sub, 38)}</text>}
                    {!compact && n.detail && <text x={n.box.x + 12} y={n.box.y + 64} className="tl-detail-line">{clip(n.detail, 32)}</text>}
                    {n.health === "untagged" && <text x={n.box.x + n.box.w - 18} y={n.box.y + 22} className="tl-q">?</text>}
                    {(n.health === "stale" || n.health === "invalid") && (
                      <text x={n.box.x + n.box.w - 10} y={n.box.y + (compact ? n.box.h / 2 + 4 : 22)} textAnchor="end" className={`tl-badge tl-badge-${n.health}`}>
                        {n.health}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        )}
        {lv && !lv.empty && <div className="tl-hint">Click to select · double-click or Enter to open · Esc goes up</div>}
      </div>

      {selected && data && <Panel id={selected} data={data} live={live} onJump={jump} onClose={() => setSelected(null)} />}
    </div>
  );
}


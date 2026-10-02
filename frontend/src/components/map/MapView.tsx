/* MapView — the "Google Maps" view of the project.
   Semantic zoom over one SVG canvas:
     zoomed out  -> modules (boxes) + the entry point
     mid         -> main functions (cards), edges between them
     zoomed in   -> cards show docs, I/O tags and the helpers folded into them
   Selecting a card opens its algorithm card (locked skeleton + filled wording) on the right. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mapApi, type AlgoStep, type AlgorithmCard, type MapFunction, type ProjectMap } from "../../lib/mapApi";
import { edgePath, layoutMap, type Box } from "../../lib/mapLayout";

const MIN_K = 0.08;
const MAX_K = 3.2;
const CARD_LEVEL = 0.5;
const DETAIL_LEVEL = 1.3;

interface View {
  x: number;
  y: number;
  k: number;
}

const STEP_ICON: Record<string, string> = {
  function: "ƒ", db: "⛁", external: "⊕", class: "C", unresolved: "?", loop: "↻", branch: "⑂", arm: "·",
  raise: "⚠", return: "↩",
};

function clip(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

function StepTree({ steps, onJump }: { steps: AlgoStep[]; onJump: (id: string) => void }) {
  return (
    <ul className="mp-steps">
      {steps.map((s) => (
        <li key={s.id}>
          <div className={`mp-step k-${s.kind}`}>
            <span className="mp-step-ico">{STEP_ICON[s.kind] ?? "·"}</span>
            {s.ref && s.kind === "function" ? (
              <button type="button" className="mp-link" onClick={() => onJump(s.ref!)}>
                {s.label}
              </button>
            ) : (
              <span>{s.label}</span>
            )}
            {s.count ? <span className="mp-count">×{s.count}</span> : null}
            {s.line ? <span className="mp-line">L{s.line}</span> : null}
          </div>
          {s.note && <div className="mp-note">{s.note}</div>}
          {s.children.length > 0 && <StepTree steps={s.children} onJump={onJump} />}
        </li>
      ))}
    </ul>
  );
}

export function MapView({ active }: { active: boolean }) {
  const [map, setMap] = useState<ProjectMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ x: 20, y: 20, k: 0.6 });
  const [selected, setSelected] = useState<string | null>(null);
  const [card, setCard] = useState<AlgorithmCard | null>(null);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const loaded = useRef(false);

  const layout = useMemo(() => (map ? layoutMap(map) : null), [map]);

  const fit = useCallback(() => {
    const el = wrapRef.current;
    if (!el || !layout) return;
    const { clientWidth: w, clientHeight: h } = el;
    const bw = layout.bounds.w + (layout.entry ? 0 : 0) + 80;
    const bh = layout.bounds.h + 80;
    const k = Math.min(Math.max(Math.min(w / bw, h / bh), MIN_K), 1);
    setView({ k, x: (w - layout.bounds.w * k) / 2, y: (h - layout.bounds.h * k) / 2 });
  }, [layout]);

  const load = useCallback(async () => {
    try {
      setError(null);
      setMap(await mapApi.map());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (active && !loaded.current) {
      loaded.current = true;
      void load();
    }
  }, [active, load]);

  useEffect(() => {
    if (layout && active) fit();
  }, [layout, active, fit]);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    mapApi.algorithm(selected).then((c) => live && setCard(c)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [selected, map]);

  // wheel = zoom around the cursor (needs a non-passive listener to stop page scroll)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      setView((v) => {
        const k = Math.min(MAX_K, Math.max(MIN_K, v.k * Math.exp(-ev.deltaY * 0.0015)));
        const r = k / v.k;
        return { k, x: px - (px - v.x) * r, y: py - (py - v.y) * r };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [map]);

  const zoomTo = useCallback(
    (box: Box, minK = DETAIL_LEVEL + 0.1) => {
      const el = wrapRef.current;
      if (!el) return;
      setView((v) => {
        const k = Math.max(v.k, minK);
        return { k, x: el.clientWidth * 0.4 - (box.x + box.w / 2) * k, y: el.clientHeight / 2 - (box.y + box.h / 2) * k };
      });
    },
    [],
  );

  const select = useCallback(
    (id: string) => {
      setSelected(id);
      const box = layout?.cards[id];
      if (box) zoomTo(box);
    },
    [layout, zoomTo],
  );

  const jump = useCallback(
    (id: string) => {
      const f = map?.functions[id];
      if (!f) return;
      // a helper is folded into its parent: jump to the first main that uses it
      const target = f.role === "main" ? id : f.used_by?.[0];
      if (target && layout?.cards[target]) select(target);
    },
    [map, layout, select],
  );

  const pin = async (id: string, role: "main" | "child" | null) => {
    await mapApi.pin(id, role);
    await load();
  };

  const handlerLabel = useMemo(() => {
    const out: Record<string, string> = {};
    for (const e of map?.endpoints ?? []) out[e.handler_id] = out[e.handler_id] ? `${out[e.handler_id]} +` : `${e.method} ${e.path}`;
    return out;
  }, [map]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !map) return [];
    return Object.values(map.functions)
      .filter((f) => f.id.toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, map]);

  const connected = useMemo(() => {
    const set = new Set<string>();
    if (selected && map) {
      set.add(selected);
      for (const e of map.edges) {
        if (e.from === selected) set.add(e.to);
        if (e.to === selected) set.add(e.from);
      }
    }
    return set;
  }, [selected, map]);

  const onPointerDown = (ev: React.PointerEvent) => {
    drag.current = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y, moved: false };
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
  };
  const onPointerMove = (ev: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = ev.clientX - d.x;
    const dy = ev.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    if (d.moved) setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };
  const onPointerUp = () => {
    const moved = drag.current?.moved;
    drag.current = null;
    if (!moved) return;
    suppressClick.current = true;
    setTimeout(() => (suppressClick.current = false), 0);
  };
  const suppressClick = useRef(false);

  const zoomBy = (f: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const px = el.clientWidth / 2;
    const py = el.clientHeight / 2;
    setView((v) => {
      const k = Math.min(MAX_K, Math.max(MIN_K, v.k * f));
      const r = k / v.k;
      return { k, x: px - (px - v.x) * r, y: py - (py - v.y) * r };
    });
  };

  const shownCard = card && card.function_id === selected ? card : null;
  const sel: MapFunction | undefined = selected && map ? map.functions[selected] : undefined;
  const level = view.k < CARD_LEVEL ? "modules" : view.k < DETAIL_LEVEL ? "functions" : "detail";

  return (
    <div className="mp-workspace">
      <div className="mp-canvas-wrap" ref={wrapRef}>
        <div className="mp-toolbar">
          <div className="mp-search">
            <input
              className="rt-input"
              placeholder="Find a function…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {matches.length > 0 && (
              <ul className="mp-search-results">
                {matches.map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setQuery("");
                        jump(f.id);
                      }}
                    >
                      <span className={`mp-role mp-role-${f.role}`}>{f.role}</span> {f.id}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {map && (
            <span className="mp-stats">
              {map.stats.main} main · {map.stats.child} helpers folded · {map.stats.edges} links
              {map.stats.unreached ? ` · ${map.stats.unreached} unreached` : ""}
            </span>
          )}
          <span className="rt-spacer" />
          <span className="mp-level">{level}</span>
          <button type="button" className="btn-icon" onClick={() => zoomBy(1.4)} title="Zoom in">＋</button>
          <button type="button" className="btn-icon" onClick={() => zoomBy(1 / 1.4)} title="Zoom out">－</button>
          <button type="button" className="btn-icon" onClick={fit} title="Fit whole project">⤢</button>
          <button type="button" className="btn-icon" onClick={() => void load()} title="Reload map">↻</button>
        </div>

        {error && <div className="mp-empty">Map not available: {error}. The analysis may still be running.</div>}
        {!error && !map && <div className="mp-empty">Loading map…</div>}
        {map && map.stats.main === 0 && <div className="mp-empty">No endpoints found, so there is nothing to map yet.</div>}

        {map && layout && (
          <svg
            className="mp-svg"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onClick={() => {
              if (!suppressClick.current) setSelected(null);
            }}
          >
            <defs>
              <marker id="mp-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" className="mp-arrow" />
              </marker>
            </defs>
            <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              {/* module boxes */}
              {map.modules.map((m) => {
                const b = layout.modules[m.module];
                if (!b) return null;
                return (
                  <g key={m.module} className={`mp-module mp-layer-${m.layer}`}>
                    <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={12} />
                    <text x={b.x + 14} y={b.y + 22} className="mp-module-name">{m.module}</text>
                    {level === "modules" && (
                      <text x={b.x + 14} y={b.y + b.h / 2 + 8} className="mp-module-count">
                        {m.functions.length} function{m.functions.length === 1 ? "" : "s"} · {m.layer}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* edges */}
              {level === "modules"
                ? layout.moduleEdges.map((e) => (
                    <path
                      key={`${e.from}>${e.to}`}
                      d={edgePath(layout.modules[e.from], layout.modules[e.to])}
                      className="mp-edge"
                      strokeWidth={Math.min(1 + e.count, 6)}
                      markerEnd="url(#mp-arrow)"
                    />
                  ))
                : map.edges.map((e) => {
                    const a = layout.cards[e.from];
                    const b = layout.cards[e.to];
                    if (!a || !b) return null;
                    const hot = selected && (e.from === selected || e.to === selected);
                    return (
                      <path
                        key={`${e.from}>${e.to}`}
                        d={edgePath(a, b)}
                        className={`mp-edge ${e.kind === "depends" ? "mp-edge-dep" : ""} ${hot ? "hot" : selected ? "dim" : ""}`}
                        markerEnd="url(#mp-arrow)"
                      />
                    );
                  })}

              {/* entry point -> modules that hold endpoint handlers */}
              {layout.entry && (
                <g className="mp-entry">
                  {map.modules
                    .filter((m) => m.functions.some((f) => handlerLabel[f]))
                    .map((m) => (
                      <path
                        key={m.module}
                        d={edgePath(layout.entry!, layout.modules[m.module])}
                        className="mp-edge mp-edge-entry"
                        markerEnd="url(#mp-arrow)"
                      />
                    ))}
                  <rect x={layout.entry.x} y={layout.entry.y} width={layout.entry.w} height={layout.entry.h} rx={45} />
                  <text x={layout.entry.x + layout.entry.w / 2} y={layout.entry.y + 38} textAnchor="middle" className="mp-entry-kind">
                    ENTRY POINT
                  </text>
                  <text x={layout.entry.x + layout.entry.w / 2} y={layout.entry.y + 58} textAnchor="middle" className="mp-entry-name">
                    {clip(layout.entry.label, 24)}
                  </text>
                </g>
              )}

              {/* function cards */}
              {level !== "modules" &&
                map.modules.flatMap((m) =>
                  m.functions.map((fid) => {
                    const f = map.functions[fid];
                    const b = layout.cards[fid];
                    if (!f || !b) return null;
                    const dim = selected && !connected.has(fid);
                    const label = handlerLabel[fid];
                    return (
                      <g
                        key={fid}
                        className={`mp-card mp-layer-${f.layer} ${selected === fid ? "selected" : ""} ${dim ? "dim" : ""}`}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          if (!suppressClick.current) select(fid);
                        }}
                      >
                        <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={8} />
                        <text x={b.x + 12} y={b.y + 22} className="mp-card-name">
                          {f.is_async ? "async " : ""}{clip(f.name, 26)}
                        </text>
                        {label && <text x={b.x + 12} y={b.y + 40} className="mp-card-route">{clip(label, 34)}</text>}
                        {level === "detail" && (
                          <>
                            <text x={b.x + 12} y={b.y + (label ? 56 : 42)} className="mp-card-doc">
                              {clip(f.doc ?? (f.signature === "()" ? "" : f.signature), 38)}
                            </text>
                            <text x={b.x + 12} y={b.y + b.h - 8} className="mp-card-meta">
                              {[
                                f.children?.length ? `${f.children.length} helper${f.children.length > 1 ? "s" : ""} inside` : "",
                                ...f.metrics.io.slice(0, 2),
                              ].filter(Boolean).join(" · ")}
                            </text>
                          </>
                        )}
                      </g>
                    );
                  }),
                )}
            </g>
          </svg>
        )}
      </div>

      {sel && (
        <aside className="mp-detail">
          <div className="mp-detail-head">
            <div>
              <div className="mp-detail-name">{sel.name}</div>
              <div className="mp-detail-id">{sel.id}</div>
            </div>
            <button type="button" className="btn-icon" onClick={() => setSelected(null)} title="Close">✕</button>
          </div>
          <div className="mp-detail-meta">
            <span className={`mp-role mp-role-${sel.role}`}>{sel.role}</span>
            <span>{sel.file_path.split("/").slice(-2).join("/")}:{sel.line}</span>
            <span>{sel.metrics.loc} lines</span>
          </div>
          <code className="mp-sig">{sel.name}{sel.signature}</code>

          <h4>Algorithm</h4>
          {!shownCard && <div className="muted">Loading…</div>}
          {shownCard && (
            <>
              <p className="mp-purpose">
                {shownCard.purpose || <span className="muted">No purpose written yet.</span>}
                <span className={`mp-fill mp-fill-${shownCard.fill_status}`}>
                  {shownCard.fill_status === "filled" ? "agent-written" : shownCard.fill_status === "stale" ? "stale" : "from code"}
                </span>
              </p>
              {shownCard.steps.length ? <StepTree steps={shownCard.steps} onJump={jump} /> : <div className="muted">No calls or decisions to show.</div>}
              {(shownCard.facts.raises.length > 0 || shownCard.facts.returns > 0) && (
                <div className="mp-facts">
                  {shownCard.facts.raises.length > 0 && <div>raises: {shownCard.facts.raises.join(", ")}</div>}
                  <div>{shownCard.facts.returns} return point{shownCard.facts.returns === 1 ? "" : "s"}</div>
                </div>
              )}
            </>
          )}

          {sel.children && sel.children.length > 0 && (
            <>
              <h4>Helpers folded in</h4>
              <div className="mp-chips">
                {sel.children.map((c) => (
                  <span key={c} className="mp-chip" title={map?.functions[c]?.reasons.join("; ")}>
                    {map?.functions[c]?.name ?? c}
                    {map?.functions[c]?.shared ? " ⇄" : ""}
                  </span>
                ))}
              </div>
            </>
          )}

          <h4>Why {sel.role}?</h4>
          <ul className="mp-reasons">
            {sel.reasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
          <div className="mp-pin">
            <button type="button" className="btn-sm" onClick={() => void pin(sel.id, sel.role === "main" ? "child" : "main")}>
              Pin as {sel.role === "main" ? "helper" : "main"}
            </button>
            <button type="button" className="btn-sm" onClick={() => void pin(sel.id, null)}>Reset</button>
          </div>
        </aside>
      )}
    </div>
  );
}

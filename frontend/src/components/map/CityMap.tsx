/* CityMap — the project as a city (reference: project_map.html in the Arthur repo).
   Districts = features, buildings = modules holding tagged code (rooms = their functions), highways = flows
   (an endpoint plus its steps), vaults = database tables. A tour walks one highway step by step.
   All of it is derived from @telelog tags; nothing here is hand-placed. Layout lives in lib/cityLayout.ts. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { telelogApi, type FlowData, type FlowStep, type LiveValues, type TelelogMapData } from "../../lib/mapApi";
import {
  BH, BW, buildCity, cameraFor, clip, fitCamera, methodColor, roundedPath, searchCity, shortName, shortPath, streetKey,
  type Building, type City, type District, type Link, type Pt, type Street,
} from "../../lib/cityLayout";
import type { Box } from "../../lib/mapLayout";
import { useRoutesValue } from "../../lib/useRoutes";
import { FieldTable, StatusBadge, ViewSwitch, type Mode } from "./TelelogMap";

interface Cam { x: number; y: number; k: number }
type Sel = { kind: "building" | "district" | "road" | "street"; id: string } | null;

function readTheme(): "dark" | "light" {
  try {
    return localStorage.getItem("cy-theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

const ROLE_GLYPH: Record<string, string> = { main: "◆", sub: "▸", helper: "·" };

/** The room names a building shows on its face, main first; what does not fit becomes "+N more". */
function roomLines(b: Building): { key: string; text: string; y: number; main: boolean; more: boolean }[] {
  const gateRows = Math.min(2, b.gates.length);
  const start = b.gates.length ? 58 + gateRows * 18 + (b.gates.length > 2 ? 12 : 0) + 14 : 66;
  const fit = Math.max(1, Math.floor((146 - start) / 12));
  const shown = b.rooms.length > fit ? fit - 1 : b.rooms.length;
  const lines = b.rooms.slice(0, shown).map((r, i) => ({
    key: r.id, text: `${ROLE_GLYPH[r.role ?? ""] ?? "·"} ${clip(r.name, 21)}`, y: start + i * 12, main: r.role === "main", more: false,
  }));
  if (b.rooms.length > shown) lines.push({ key: "more", text: `+${b.rooms.length - shown} more`, y: start + shown * 12, main: false, more: true });
  return lines;
}

export function CityMap({ active, mode, onSwitch }: { active: boolean; mode: Mode; onSwitch: (m: Mode) => void }) {
  const [data, setData] = useState<TelelogMapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cam, setCam] = useState<Cam>({ x: 20, y: 120, k: 0.5 });
  const [sel, setSel] = useState<Sel>(null);
  const [roomFn, setRoomFn] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
  const [hot, setHot] = useState<Set<string> | null>(null);
  const [showHighways, setShowHighways] = useState(false);
  const [tour, setTour] = useState<{ road: string; i: number } | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(readTheme);
  const [code, setCode] = useState<{ id: string; text: string; truncated: boolean } | null>(null);
  const [liveFor, setLive] = useState<{ id: string; values: LiveValues } | null>(null);
  const [run, setRun] = useState<(FlowData & { i: number; playing: boolean; speed: number }) | null>(null);
  const [follow, setFollow] = useState(true);
  const carRef = useRef<SVGGElement>(null);
  const locRef = useRef<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const anim = useRef(0);
  const generation = useRoutesValue((s) => s.analysis?.generation ?? 0);
  const [vp, setVp] = useState({ w: 1000, h: 700 });

  const load = useCallback(async () => {
    try {
      setError(null);
      setData(await telelogApi.map());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    if (active) void load();
  }, [active, generation, load]);

  // canvas size as state (not read from the ref while rendering), so the minimap's viewport box follows a resize
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setVp({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setVp({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const city: City | null = useMemo(() => (data ? buildCity(data) : null), [data]);

  // ── Run flow: play an endpoint's call order down through the lower functions ──────────────────────────────────
  const streetById = useMemo(() => new Map((city?.streets ?? []).map((st) => [st.id, st])), [city]);
  const stepBuilding = useCallback((steps: FlowStep[], st: FlowStep | undefined): string | null => {
    if (!st || !city) return null;
    if (st.kind === "fn") return city.byFn[st.id] ?? null;
    if (st.kind === "db" && city.buildings[`b:vault|${st.id}`]) return `b:vault|${st.id}`;
    return st.parent != null ? stepBuilding(steps, steps[st.parent]) : null; // library calls happen inside their caller
  }, [city]);
  const centerOf = useCallback((id: string): Pt => {
    const b = city?.buildings[id];
    return b ? { x: b.box.x + BW / 2, y: b.box.y + BH / 2 } : { x: 0, y: 0 };
  }, [city]);
  const legPoints = useCallback((from: string, to: string, via: string | null): Pt[] => {
    const direct = (a: string, b: string): Pt[] | null => {
      const st = streetById.get(`s:${streetKey(a, b)}`);
      return st ? (st.a === a ? st.points : [...st.points].reverse()) : null;
    };
    const d = direct(from, to);
    if (d) return d;
    if (via && via !== from && via !== to) {
      const a = direct(from, via), b = direct(via, to);
      if (a && b) return [...a, ...b];
    }
    return [centerOf(from), centerOf(to)];
  }, [streetById, centerOf]);

  const startRun = async (handler: string) => {
    try {
      const flow = await telelogApi.flow(handler);
      if (!flow.steps.length) return;
      locRef.current = null;
      setSel(null); setHot(null); setTour(null);
      setRun({ ...flow, i: 0, playing: true, speed: 1 });
    } catch {
      setError("Could not read the call order for that endpoint.");
    }
  };
  const stopRun = () => { setRun(null); locRef.current = null; };

  // everything the flow has touched so far: buildings and the streets it travelled
  const trail = useMemo(() => {
    if (!run || !city) return null;
    const buildings = new Set<string>(), streets = new Set<string>();
    let prev: string | null = null;
    for (let k = 0; k <= run.i; k++) {
      const b = stepBuilding(run.steps, run.steps[k]);
      if (!b) continue;
      buildings.add(b);
      if (prev && prev !== b) {
        const st = streetById.get(`s:${streetKey(prev, b)}`);
        if (st) streets.add(st.id);
      }
      prev = b;
    }
    return { buildings, streets };
  }, [run, city, stepBuilding, streetById]);

  const runI = run?.i ?? -1, runPlaying = run?.playing ?? false, runSpeed = run?.speed ?? 1, runLen = run?.steps.length ?? 0;
  useEffect(() => {
    if (!run || !city) return;
    const target = stepBuilding(run.steps, run.steps[run.i]);
    const parent = run.steps[run.i].parent;
    const via = parent != null ? stepBuilding(run.steps, run.steps[parent]) : null;
    const from = locRef.current;
    const pts = from && target && from !== target ? legPoints(from, target, via) : [];
    const len = pts.reduce((n, p, k) => (k ? n + Math.hypot(p.x - pts[k - 1].x, p.y - pts[k - 1].y) : 0), 0);
    const moveMs = pts.length ? Math.min(1700, Math.max(420, len / 0.5)) / runSpeed : 0;
    const dwell = 650 / runSpeed;
    const place = (pt: Pt) => carRef.current?.setAttribute("transform", `translate(${pt.x},${pt.y})`);
    const at = (f: number): Pt => {
      let want = f * len;
      for (let k = 1; k < pts.length; k++) {
        const seg = Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y);
        if (want <= seg || k === pts.length - 1) { const u = seg ? Math.min(1, want / seg) : 1; return { x: pts[k - 1].x + (pts[k].x - pts[k - 1].x) * u, y: pts[k - 1].y + (pts[k].y - pts[k - 1].y) * u }; }
        want -= seg;
      }
      return pts[pts.length - 1];
    };
    if (target && follow && target !== from) flyBox(city.buildings[target].box, Math.max(0.85, Math.min(cam.k, 1.3)));
    if (!pts.length && target) place(centerOf(target));
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = now - t0;
      if (pts.length && t < moveMs) place(at(t / moveMs));
      else if (target) place(centerOf(target));
      if (t >= moveMs + dwell) {
        locRef.current = target ?? from;
        if (runPlaying) setRun((r) => (r && r.i === runI ? (r.i < r.steps.length - 1 ? { ...r, i: r.i + 1 } : { ...r, playing: false }) : r));
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // the loop restarts per step / play-state / speed; camera, city and helpers are read fresh inside
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runI, runPlaying, runSpeed, runLen, city]);

  const size = () => {
    const el = wrapRef.current;
    return { w: el?.clientWidth ?? 1000, h: el?.clientHeight ?? 700 };
  };

  const flyTo = useCallback((target: Cam, ms = 650) => {
    cancelAnimationFrame(anim.current);
    const start = performance.now();
    let from: Cam = { x: 0, y: 0, k: 1 };
    setCam((c) => { from = c; return c; });
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const e = ease(t);
      setCam({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, k: from.k + (target.k - from.k) * e });
      if (t < 1) anim.current = requestAnimationFrame(frame);
    };
    anim.current = requestAnimationFrame(frame);
  }, []);
  useEffect(() => () => cancelAnimationFrame(anim.current), []);

  const inset = sel ? 380 : 0;
  const flyBox = useCallback((box: Box, zoom: number) => {
    const { w, h } = size();
    flyTo(cameraFor(box, w, h, zoom, inset));
  }, [flyTo, inset]);

  const fit = useCallback(() => {
    if (!city) return;
    const { w, h } = size();
    setCam(fitCamera(city.bounds, w - inset, h));
  }, [city, inset]);
  const fitted = useRef<City | null>(null);
  useEffect(() => {
    if (active && city && fitted.current !== city) {
      fitted.current = city;
      fit();
    }
  }, [active, city, fit]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      cancelAnimationFrame(anim.current);
      const r = el.getBoundingClientRect();
      const px = ev.clientX - r.left, py = ev.clientY - r.top;
      setCam((v) => {
        const k = Math.min(3, Math.max(0.1, v.k * Math.exp(-ev.deltaY * 0.0015)));
        const q = k / v.k;
        return { k, x: px - (px - v.x) * q, y: py - (py - v.y) * q };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // code preview and live values for the room being looked at
  const selBuilding: Building | null = city && sel?.kind === "building" ? city.buildings[sel.id] ?? null : null;
  const activeRoom = selBuilding ? (roomFn && selBuilding.rooms.some((r) => r.id === roomFn) ? roomFn : selBuilding.rooms[0]?.id ?? null) : null;
  useEffect(() => {
    if (!activeRoom || selBuilding?.kind === "vault") return;
    let alive = true;
    telelogApi.source(activeRoom).then((s) => alive && s && setCode({ id: activeRoom, text: s.text, truncated: s.truncated })).catch(() => undefined);
    if (data?.functions[activeRoom]) {
      telelogApi.live(activeRoom).then((values) => alive && setLive({ id: activeRoom, values })).catch(() => undefined);
    }
    return () => { alive = false; };
  }, [activeRoom, selBuilding, data]);
  const codeNow = code && code.id === activeRoom ? code : null;
  const live = liveFor && liveFor.id === activeRoom ? liveFor.values : null;

  const selectBuilding = useCallback((id: string, fn?: string) => {
    if (!city) return;
    setSel({ kind: "building", id });
    setRoomFn(fn ?? null);
    flyBox(city.buildings[id].box, 1.3);
  }, [city, flyBox]);

  const startTour = (roadId: string) => {
    const road = city?.roads.find((r) => r.id === roadId);
    if (!road || !city) return;
    setTour({ road: roadId, i: 0 });
    setHot(new Set([roadId]));
    const b = city.buildings[road.steps[0].building];
    if (b) { setSel({ kind: "building", id: b.id }); setRoomFn(road.steps[0].fn); flyBox(b.box, 1.4); }
  };
  const goStep = (delta: number) => {
    if (!tour || !city) return;
    const road = city.roads.find((r) => r.id === tour.road);
    if (!road) return;
    const i = Math.max(0, Math.min(road.steps.length - 1, tour.i + delta));
    setTour({ road: tour.road, i });
    const st = road.steps[i];
    const b = city.buildings[st.building];
    if (b) { setSel({ kind: "building", id: b.id }); setRoomFn(st.fn); flyBox(b.box, 1.4); }
  };
  const stopTour = () => { setTour(null); setHot(null); };

  const clear = () => { setSel(null); setHot(null); setTour(null); setFocus(null); };

  const onKeyDown = (ev: React.KeyboardEvent) => {
    const t = ev.target as HTMLElement;
    const typing = t.tagName === "INPUT" || t.tagName === "SELECT";
    if (ev.key === "Escape") {
      if (typing) { setQuery(""); (t as HTMLInputElement).blur?.(); return; }
      if (run) stopRun(); else if (tour) stopTour(); else if (sel || hot || focus) clear();
    } else if (ev.key === "/" && !typing) {
      ev.preventDefault();
      searchRef.current?.focus();
    } else if ((ev.key === "Enter" || ev.key === " ") && t.getAttribute?.("data-bid")) {
      ev.preventDefault();
      selectBuilding(t.getAttribute("data-bid")!);
    }
  };

  const tours = useMemo(() => [...(city?.roads ?? [])].sort((a, b) => b.steps.length - a.steps.length || a.id.localeCompare(b.id)), [city]);
  const results = useMemo(() => (city ? searchCity(city, query) : []), [city, query]);
  const pick = (s: (typeof results)[number]) => {
    setQuery("");
    if (!city) return;
    if (s.kind === "district") {
      const d = city.districts.find((x) => x.id === s.id)!;
      setSel({ kind: "district", id: d.id });
      flyBox(d.box, 0.7);
    } else if (s.kind === "road") {
      setSel({ kind: "road", id: s.id });
      setHot(new Set([s.id]));
    } else selectBuilding(s.target, s.fn);
  };

  const zoomBy = (f: number) => {
    const { w, h } = size();
    setCam((v) => {
      const k = Math.min(3, Math.max(0.1, v.k * f));
      const q = k / v.k;
      return { k, x: (w - inset) / 2 - ((w - inset) / 2 - v.x) * q, y: h / 2 - (h / 2 - v.y) * q };
    });
  };

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try { localStorage.setItem("cy-theme", next); } catch { /* storage unavailable: keep for this session */ }
  };

  const inFocus = (d: District) => !focus || focus === d.id;
  const selDistrict = city && sel?.kind === "district" ? city.districts.find((d) => d.id === sel.id) ?? null : null;
  const selRoad = city && sel?.kind === "road" ? city.roads.find((r) => r.id === sel.id) ?? null : null;
  const roadsOf = (b: Building) => (city?.roads ?? []).filter((r) => b.roads.includes(r.id));
  const selStreet = city && sel?.kind === "street" ? city.streets.find((x) => x.id === sel.id) ?? null : null;
  // which streets are "lit": the ones around the selected building, narrowed to the selected room's own calls
  const roomLinks = (st: Street): Link[] => (activeRoom && selBuilding ? st.links.filter((l) => l.from === activeRoom || l.to === activeRoom) : st.links);
  const litStreets = useMemo(() => {
    if (!city) return null;
    if (selStreet) return new Set([selStreet.id]);
    if (!selBuilding) return null;
    const near = city.streets.filter((x) => x.a === selBuilding.id || x.b === selBuilding.id);
    const mine = activeRoom ? near.filter((x) => x.links.some((l) => l.from === activeRoom || l.to === activeRoom)) : near;
    return new Set((mine.length ? mine : near).map((x) => x.id));
  }, [city, selStreet, selBuilding, activeRoom]);
  const hotStreets = useMemo(() => {
    if (!city || !hot) return null;
    const ids = new Set<string>();
    for (const r of city.roads) if (hot.has(r.id)) for (let i = 1; i < r.buildings.length; i++) ids.add(`s:${streetKey(r.buildings[i - 1], r.buildings[i])}`);
    return ids;
  }, [city, hot]);
  const tourRoad = tour && city ? city.roads.find((r) => r.id === tour.road) ?? null : null;
  const view = vp;
  const cov = data?.coverage;
  const roomCount = city ? Object.values(city.buildings).reduce((n, b) => n + (b.kind === "building" ? b.rooms.length : 0), 0) : 0;

  const mini = useMemo(() => (city ? { w: 150, h: Math.max(40, Math.round((150 * city.bounds.h) / Math.max(city.bounds.w, 1))) } : null), [city]);
  const miniClick = (ev: React.MouseEvent<SVGSVGElement>) => {
    if (!city || !mini) return;
    const r = ev.currentTarget.getBoundingClientRect();
    const wx = ((ev.clientX - r.left) / r.width) * city.bounds.w;
    const wy = ((ev.clientY - r.top) / r.height) * city.bounds.h;
    flyBox({ x: wx - 1, y: wy - 1, w: 2, h: 2 }, cam.k);
  };

  return (
    <div className={`mp-workspace cy-root cy-${theme}`} onKeyDown={onKeyDown}>
      <div className="mp-canvas-wrap cy-canvas" ref={wrapRef}>
        <div className="cy-top">
          <div className="cy-top-left">
            <div className="cy-row">
              <ViewSwitch mode={mode} onChange={onSwitch} />
              <span className="cy-stat">
                {city ? `${city.districts.length} districts · ${Object.keys(city.buildings).length} buildings · ${roomCount} rooms` : ""}
                {cov ? ` · ${cov.tagged}/${cov.total} tagged` : ""}
              </span>
            </div>
            <div className="cy-search">
              <input
                ref={searchRef}
                className="cy-input"
                placeholder="Search functions, modules, endpoints, districts…  ( / )"
                aria-label="Search the city"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {results.length > 0 && (
                <ul className="cy-results">
                  {results.map((s) => (
                    <li key={s.id}>
                      <button type="button" onClick={() => pick(s)}>
                        <span className={`cy-badge cy-badge-${s.kind}`}>{s.kind}</span>
                        <span className="cy-rt">{s.title}</span>
                        <span className="cy-rs">{clip(s.sub, 40)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {city && (
              <div className="cy-chips" role="group" aria-label="Filter districts">
                <button type="button" className={`cy-chip ${!focus ? "on" : ""}`} aria-pressed={!focus} onClick={() => { setFocus(null); fit(); }}>All city</button>
                <button type="button" className={`cy-chip ${showHighways ? "" : "off"}`} aria-pressed={showHighways} onClick={() => setShowHighways(!showHighways)}>
                  Highways ({city.roads.filter((r) => r.points.length > 1).length})
                </button>
                {city.districts.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className={`cy-chip ${focus === d.id ? "on" : ""}`}
                    aria-pressed={focus === d.id}
                    style={{ ["--dc" as string]: d.color }}
                    onClick={() => { setFocus(d.id); setSel({ kind: "district", id: d.id }); flyBox(d.box, 0.8); }}
                  >
                    <i className="cy-dot" />{clip(d.name, 22)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="cy-top-right">
            {tours.slice(0, 3).map((r) => (
              <button key={r.id} type="button" className={`cy-tour ${tour?.road === r.id ? "on" : ""}`} onClick={() => startTour(r.id)} title={`Tour: ${r.route ?? r.name} (${r.steps.length} stops)`}>
                ▶ {r.gate ? `${r.gate.method} ${shortPath(r.gate.path, 18)}` : clip(r.name, 24)}
              </button>
            ))}
            {tours.length > 3 && (
              <select className="cy-tour" aria-label="More tours" value="" onChange={(e) => e.target.value && startTour(e.target.value)}>
                <option value="">All tours ({tours.length})…</option>
                {tours.map((r) => <option key={r.id} value={r.id}>{r.route ?? r.name} · {r.steps.length} stops</option>)}
              </select>
            )}
            <button type="button" className="cy-tour" onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to day map" : "Switch to night map"} title="Day / night">
              {theme === "dark" ? "☀" : "☾"}
            </button>
          </div>
        </div>

        {cov && cov.tagged === 0 && (
          <div className="tl-banner cy-banner" role="status">
            No telelog tags yet, so everything sits in the outskirts. Run <code>/telelog</code> in Claude Code.
          </div>
        )}
        {error && <div className="mp-empty">City not available: {error}. The analysis may still be running.</div>}
        {!error && !data && <div className="mp-empty">Loading city…</div>}
        {city && city.districts.length === 0 && <div className="mp-empty">Nothing to show yet.</div>}

        {city && (
          <svg
            className="mp-svg cy-svg"
            role="group"
            aria-label="Project city map"
            onPointerDown={(ev) => {
              cancelAnimationFrame(anim.current);
              drag.current = { x: ev.clientX, y: ev.clientY, cx: cam.x, cy: cam.y, moved: false };
              (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
            }}
            onPointerMove={(ev) => {
              const d = drag.current;
              if (!d) return;
              const dx = ev.clientX - d.x, dy = ev.clientY - d.y;
              if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
              if (d.moved) setCam((c) => ({ ...c, x: d.cx + dx, y: d.cy + dy }));
            }}
            onPointerUp={() => {
              if (drag.current?.moved) { suppressClick.current = true; setTimeout(() => { suppressClick.current = false; }, 0); }
              drag.current = null;
            }}
            onClick={() => { if (!suppressClick.current) clear(); }}
          >
            <g transform={`translate(${cam.x},${cam.y}) scale(${cam.k})`}>
              {city.districts.map((d) => (
                <g
                  key={d.id}
                  className={`cy-district ${inFocus(d) ? "" : "dim"} ${d.kind}`}
                  style={{ ["--dc" as string]: d.color }}
                  onClick={(ev) => { ev.stopPropagation(); if (!suppressClick.current) { setSel({ kind: "district", id: d.id }); flyBox(d.box, 0.8); } }}
                >
                  <rect x={d.box.x} y={d.box.y} width={d.box.w} height={d.box.h} rx={22} />
                  <text x={d.box.x + 22} y={d.box.y + 38} className="cy-dname">{d.name.toUpperCase()}</text>
                </g>
              ))}

              {city.entryLinks.map((l) => {
                const a = city.buildings[l.from], b = city.buildings[l.to];
                if (!a || !b) return null;
                const lit = sel?.kind === "building" && (sel.id === l.from || sel.id === l.to);
                return <path key={`${l.from}>${l.to}`} className={`cy-link ${lit ? "lit" : ""}`} d={`M${a.box.x + BW / 2},${a.box.y + BH / 2} L${b.box.x + BW / 2},${b.box.y + BH / 2}`} />;
              })}

              {city.pipes.map((p, i) => {
                const a = city.buildings[p.from], b = city.buildings[p.to];
                if (!a || !b) return null;
                if (!(sel?.kind === "building" && (sel.id === p.from || sel.id === p.to))) return null;
                return (
                  <path key={i} className="cy-pipe" d={`M${a.box.x + BW / 2},${a.box.y + BH} L${b.box.x + BW / 2},${b.box.y}`}>
                    <title>{p.mode === "r" ? "reads" : p.mode === "w" ? "writes" : "reads and writes"}</title>
                  </path>
                );
              })}

              {city.streets.map((st) => {
                const dim = (litStreets && !litStreets.has(st.id)) || (hotStreets && !hotStreets.has(st.id)) || (trail && !trail.streets.has(st.id));
                const A = city.buildings[st.a], B = city.buildings[st.b];
                const d = roundedPath(st.points);
                const pairs = st.links.slice(0, 12).map((l) => `${shortName(l.from)} → ${shortName(l.to)}${l.n > 1 ? ` ×${l.n}` : ""}`);
                return (
                  <g key={st.id} className={`cy-street ${dim ? "dim" : ""} ${litStreets?.has(st.id) ? "lit" : ""} ${trail?.streets.has(st.id) ? "run" : ""}`}
                    onClick={(ev) => { ev.stopPropagation(); if (!suppressClick.current) { setSel({ kind: "street", id: st.id }); setHot(null); setTour(null); } }}>
                    <path d={d} className="cy-street-edge" style={{ strokeWidth: st.width + 5 }} />
                    <path d={d} className="cy-street-fill" style={{ strokeWidth: st.width }} />
                    <path d={d} className="cy-street-dash" />
                    {st.arrows.map((ar, i) => (
                      <path key={i} d="M-5,-4.5 L4,0 L-5,4.5 z" className="cy-chev" transform={`translate(${ar.x},${ar.y}) rotate(${ar.angle})`} />
                    ))}
                    <path d={d} className="cy-street-hit" style={{ strokeWidth: st.width + 16 }}>
                      <title>{`${A.title} ↔ ${B.title}: ${st.count} call${st.count === 1 ? "" : "s"} (${st.ab} →, ${st.ba} ←)\n${pairs.join("\n")}${st.links.length > 12 ? `\n+${st.links.length - 12} more` : ""}`}</title>
                    </path>
                  </g>
                );
              })}

              {city.roads.map((r) => {
                const on = showHighways ? !hot || hot.has(r.id) : !!hot?.has(r.id);
                if (run || !on || r.points.length < 2) return null;
                const d = roundedPath(r.points, 18);
                const isHot = !!hot?.has(r.id);
                return (
                  <g key={r.id} className={`cy-road ${isHot ? "hot" : ""}`} onClick={(ev) => { ev.stopPropagation(); setSel({ kind: "road", id: r.id }); setHot(new Set([r.id])); }}>
                    <path d={d} className="cy-hw-glow" style={{ stroke: r.color }} />
                    <path d={d} className="cy-hw-fill" style={{ stroke: r.color }} />
                    <path d={d} className="cy-hw-dash" />
                    {isHot && (
                      <circle r={5.5} className="cy-car">
                        <animateMotion dur="5s" repeatCount="indefinite" path={d} />
                      </circle>
                    )}
                  </g>
                );
              })}

              {Object.values(city.buildings).map((b) => {
                const d = city.districts.find((x) => x.id === b.district)!;
                const dim = (focus && b.district !== focus) || (hot && !b.roads.some((id) => hot.has(id)) && b.kind === "building") || (trail && !trail.buildings.has(b.id));
                const isCur = !!run && stepBuilding(run.steps, run.steps[run.i]) === b.id;
                const isSel = sel?.kind === "building" && sel.id === b.id;
                const label = `${b.title}, ${b.rooms.length} ${b.kind === "vault" ? "users" : "rooms"}${b.health !== "ok" ? `, ${b.health}` : ""}`;
                return (
                  <g
                    key={b.id}
                    data-bid={b.id}
                    tabIndex={0}
                    role="button"
                    aria-label={label}
                    aria-pressed={isSel}
                    className={`cy-building cy-${b.kind} cy-h-${b.health} ${isSel ? "selected" : ""} ${dim ? "dim" : ""} ${isCur ? "run-cur" : ""}`}
                    style={{ ["--dc" as string]: d.color }}
                    onClick={(ev) => { ev.stopPropagation(); if (!suppressClick.current) selectBuilding(b.id); }}
                  >
                    <rect x={b.box.x + 5} y={b.box.y + 6} width={b.box.w} height={b.box.h} rx={8} className="cy-shadow" />
                    <rect x={b.box.x} y={b.box.y} width={b.box.w} height={b.box.h} rx={8} className="cy-body" />
                    <rect x={b.box.x} y={b.box.y} width={b.box.w} height={9} rx={4} className="cy-roof" />
                    <text x={b.box.x + 12} y={b.box.y + 33} className="cy-btitle">{clip(b.title, 18)}</text>
                    <text x={b.box.x + 12} y={b.box.y + 51} className="cy-bfile">{clip(b.file.split("/").slice(-2).join("/"), 26)}</text>
                    {b.kind === "entry" ? (
                      <text x={b.box.x + 12} y={b.box.y + 72} className="cy-room cy-room-main">▶ application entry</text>
                    ) : (
                      <>
                        {b.gates.slice(0, 2).map((g, i) => (
                          <g key={`${g.method}${g.path}`} className="cy-gate">
                            <rect x={b.box.x + 10} y={b.box.y + 58 + i * 18} width={40} height={14} rx={3} style={{ fill: methodColor(g.method) }} />
                            <text x={b.box.x + 30} y={b.box.y + 68.5 + i * 18} textAnchor="middle" className="cy-gate-m">{g.method}</text>
                            <text x={b.box.x + 56} y={b.box.y + 68.5 + i * 18} className="cy-gate-p">{shortPath(g.path, 15)}</text>
                          </g>
                        ))}
                        {b.gates.length > 2 && <text x={b.box.x + 12} y={b.box.y + 100} className="cy-more">+{b.gates.length - 2} more gates</text>}
                        {b.kind !== "vault" && roomLines(b).map((ln) => (
                          <text key={ln.key} x={b.box.x + 12} y={b.box.y + ln.y} className={`cy-room ${ln.main ? "cy-room-main" : ""} ${ln.more ? "cy-more" : ""}`}>{ln.text}</text>
                        ))}
                      </>
                    )}
                    <text x={b.box.x + 12} y={b.box.y + b.box.h - 9} className="cy-brooms">
                      {b.kind === "vault" ? `${b.rooms.length} user${b.rooms.length === 1 ? "" : "s"}`
                        : b.kind === "entry" ? `${data?.endpoint_count ?? 0} endpoints · ${city.entryLinks.filter((l) => l.from === b.id).length} gateways`
                        : `${b.rooms.length} room${b.rooms.length === 1 ? "" : "s"} (sub-funcs)`}
                    </text>
                    {(b.health === "stale" || b.health === "invalid") && (
                      <text x={b.box.x + b.box.w - 8} y={b.box.y + 33} textAnchor="end" className={`tl-badge tl-badge-${b.health}`}>{b.health}</text>
                    )}
                    {b.health === "untagged" && <text x={b.box.x + b.box.w - 16} y={b.box.y + 33} className="tl-q">?</text>}
                  </g>
                );
              })}
              {city.roads.map((r) => {
                if (!r.start || !r.gate) return null;
                const dim = hot && !hot.has(r.id);
                return (
                  <g key={`s-${r.id}`} className={`cy-start ${dim ? "dim" : ""}`}>
                    <circle cx={r.start.x} cy={r.start.y} r={10} className="cy-start-dot" style={{ fill: methodColor(r.gate.method) }} />
                    <text x={r.start.x} y={r.start.y + 4} textAnchor="middle" className="cy-start-m">{r.gate.method[0]}</text>
                    <title>{r.gate.method} {r.gate.path}: highway starts here</title>
                  </g>
                );
              })}
              {city.roads.map((r) => {
                // highway labels pile up where many share a building: show them for the highlighted one, or for every one in a small city
                const show = hot ? hot.has(r.id) : showHighways && city.roads.length <= 8 && cam.k >= 0.55;
                if (!show || !r.label) return null;
                return (
                  <g key={`l-${r.id}`}>
                    <rect x={r.label.x - r.label.w / 2 - 4} y={r.label.y - 11} width={r.label.w + 8} height={15} rx={7} className="cy-label-bg" />
                    <text x={r.label.x} y={r.label.y} textAnchor="middle" className="cy-road-label">{r.label.text}</text>
                  </g>
                );
              })}
              {litStreets && city.streets.filter((st) => litStreets.has(st.id)).map((st) => {
                const links = roomLinks(st);
                const lines = links.slice(0, 3).map((l) => `${shortName(l.from)} → ${shortName(l.to)}${l.n > 1 ? ` ×${l.n}` : ""}`);
                if (links.length > 3) lines.push(`+${links.length - 3} more`);
                // anchor the labels just outside the selected building, where the eye already is
                const atStart = selStreet || selBuilding?.id !== st.b;
                const p0 = atStart ? st.points[0] : st.points[st.points.length - 1];
                const p1 = atStart ? st.points[1] : st.points[st.points.length - 2];
                const seg = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
                const along = Math.min(28, seg / 2);
                const ux = (p1.x - p0.x) / seg, uy = (p1.y - p0.y) / seg;
                const x = p0.x + ux * along, y = p0.y + uy * along;
                // pills run away from the building along the street, so they never cover the building's own text
                const anchor = ux > 0.5 ? "start" : ux < -0.5 ? "end" : "middle";
                return (
                  <g key={`p-${st.id}`} className="cy-pairs">
                    {lines.map((t, i) => {
                      const w = t.length * 6.9 + 14;
                      const x0 = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
                      const ty = y + 4 + (i - (lines.length - 1) / 2) * 17;
                      return (
                        <g key={i}>
                          <rect x={x0} y={ty - 12} width={w} height={16} rx={8} className="cy-pair-bg" />
                          <text x={x0 + w / 2} y={ty} textAnchor="middle" className="cy-pair">{t}</text>
                        </g>
                      );
                    })}
                  </g>
                );
              })}
              {run && (() => {
                const cur = run.steps[run.i];
                const b = city.buildings[stepBuilding(run.steps, cur) ?? ""];
                const name = cur.kind === "fn" ? shortName(cur.id) : cur.id;
                const w = Math.min(260, name.length * 7.4 + 34);
                return b ? (
                  <g className="cy-runtag">
                    <rect x={b.box.x + BW / 2 - w / 2} y={b.box.y - 30} width={w} height={22} rx={11} className="cy-runtag-bg" />
                    <text x={b.box.x + BW / 2} y={b.box.y - 15} textAnchor="middle" className="cy-runtag-text">▶ {clip(name, 32)}</text>
                  </g>
                ) : null;
              })()}
              {run && (
                <g ref={carRef} className="cy-runcar">
                  <circle r={13} className="cy-runcar-halo" />
                  <circle r={6.5} className="cy-runcar-dot" />
                </g>
              )}
            </g>
          </svg>
        )}

        {city && mini && (
          <svg
            className="cy-mini"
            width={mini.w}
            height={mini.h}
            viewBox={`0 0 ${city.bounds.w} ${city.bounds.h}`}
            preserveAspectRatio="none"
            onClick={miniClick}
            aria-label="Minimap"
          >
            {city.districts.map((d) => <rect key={d.id} x={d.box.x} y={d.box.y} width={d.box.w} height={d.box.h} fill={d.color} fillOpacity={0.35} />)}
            {Object.values(city.buildings).map((b) => <rect key={b.id} x={b.box.x} y={b.box.y} width={b.box.w} height={b.box.h} className="cy-mini-b" />)}
            <rect
              className="cy-mini-view"
              x={-cam.x / cam.k}
              y={-cam.y / cam.k}
              width={(view.w - inset) / cam.k}
              height={view.h / cam.k}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
        <div className="cy-controls" style={{ right: 16 }}>
          <button type="button" onClick={() => zoomBy(1.3)} aria-label="Zoom in">+</button>
          <button type="button" onClick={() => zoomBy(1 / 1.3)} aria-label="Zoom out">−</button>
          <button type="button" onClick={() => { clear(); fit(); }} aria-label="Show the whole city" title="Whole city">◎</button>
          <button type="button" onClick={() => void load()} aria-label="Reload" title="Reload">↻</button>
        </div>

        {run && (() => {
          const cur = run.steps[run.i];
          const parentStep = cur.parent != null ? run.steps[cur.parent] : null;
          const fn = cur.kind === "fn" ? data?.functions[cur.id] : undefined;
          const name = (st: FlowStep) => (st.kind === "fn" ? shortName(st.id) : st.id);
          const what = cur.kind === "fn" ? (fn?.purpose && fn.purpose !== "?" ? fn.purpose : "No description written for this function yet.")
            : cur.kind === "db" ? `Touches the ${cur.id} table.` : `Calls the library function ${cur.id}.`;
          const go = (i: number, playing: boolean) => { if (i === 0) locRef.current = null; setRun({ ...run, i: Math.max(0, Math.min(run.steps.length - 1, i)), playing }); };
          return (
            <div className="cy-flowcard" role="dialog" aria-label="Run flow">
              <div className="cy-tourhead">
                <span className="cy-step cy-step-flow">FLOW · STEP {run.i + 1} OF {run.steps.length}{run.truncated ? "+" : ""}</span>
                <span className="cy-tourname">{run.route ?? shortName(run.handler)}</span>
                <button type="button" className="btn-icon" onClick={stopRun} aria-label="Stop the flow">✕</button>
              </div>
              <h3>
                <span className="cy-glyph">{cur.kind === "db" ? "⛁" : cur.kind === "external" ? "⊕" : "▸"}</span> {name(cur)}
                {cur.repeat && <span className="cy-repeat">called again{cur.recursive ? " (recursive)" : ""}</span>}
              </h3>
              <p className="cy-flowmeta">
                {parentStep ? <>called by <b>{name(parentStep)}</b>{cur.line ? ` at line ${cur.line}` : ""} · {cur.edge}</> : "the endpoint handler: where the request enters"}
              </p>
              <p>{what}</p>
              <div className="cy-flowctl">
                <button type="button" className="btn-sm" onClick={() => go(0, true)} aria-label="Restart">⏮</button>
                <button type="button" className="btn-sm" onClick={() => go(run.i - 1, false)} aria-label="Previous step">◀</button>
                <button type="button" className="btn-sm cy-primary" onClick={() => go(run.i >= run.steps.length - 1 && !run.playing ? 0 : run.i, !run.playing)}>
                  {run.playing ? "⏸ Pause" : run.i >= run.steps.length - 1 ? "↺ Replay" : "▶ Play"}
                </button>
                <button type="button" className="btn-sm" onClick={() => go(run.i + 1, false)} aria-label="Next step">▶</button>
                <select className="btn-sm" aria-label="Speed" value={run.speed} onChange={(e) => setRun({ ...run, speed: Number(e.target.value) })}>
                  {[0.5, 1, 2, 4].map((v) => <option key={v} value={v}>{v}×</option>)}
                </select>
                <label className="cy-follow"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow</label>
              </div>
              <ol className="cy-stack" aria-label="Call order">
                {run.steps.map((st) => (
                  <li key={st.i} ref={st.i === run.i ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                    className={`${st.i === run.i ? "cur" : st.i < run.i ? "done" : ""} ${st.repeat ? "rep" : ""} k-${st.kind}`} style={{ paddingLeft: 6 + Math.min(st.depth, 12) * 12 }}>
                    <button type="button" onClick={() => go(st.i, false)}>
                      {st.kind === "db" ? "⛁" : st.kind === "external" ? "⊕" : "▸"} {clip(name(st), 40)}{st.repeat ? " ↺" : ""}
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          );
        })()}

        {tourRoad && tour && (
          <div className="cy-tourcard" role="dialog" aria-label="Guided tour">
            <div className="cy-tourhead">
              <span className="cy-step">STEP {tour.i + 1} OF {tourRoad.steps.length}</span>
              <span className="cy-tourname">{tourRoad.name}</span>
              <button type="button" className="btn-icon" onClick={stopTour} aria-label="End tour">✕</button>
            </div>
            <h3>{tourRoad.steps[tour.i].title}</h3>
            <p>{tourRoad.steps[tour.i].desc}</p>
            <div className="cy-tourbtns">
              <button type="button" className="btn-sm" disabled={tour.i === 0} onClick={() => goStep(-1)}>← Previous</button>
              <button type="button" className="btn-sm cy-primary" disabled={tour.i === tourRoad.steps.length - 1} onClick={() => goStep(1)}>Next step →</button>
            </div>
          </div>
        )}
      </div>

      {selBuilding && selBuilding.kind === "entry" && city && (
        <aside className="mp-detail tl-detail cy-panel" aria-label="Entry point details">
          <div className="cy-phead">
            <div>
              <div className="cy-pkind">APPLICATION ENTRY POINT</div>
              <div className="cy-pname">{selBuilding.title}</div>
            </div>
            <button type="button" className="btn-icon" onClick={clear} aria-label="Close details" title="Close (Esc)">✕</button>
          </div>
          <h4>Source location</h4>
          <code className="cy-file">{selBuilding.file}</code>
          <p className="mp-purpose">{data?.endpoint_count ?? 0} endpoints enter here. Each highway starts at a gate on the building that handles it.</p>
          <h4>Gateways ({city.entryLinks.filter((l) => l.from === selBuilding.id).length})</h4>
          <div className="cy-links">
            {city.entryLinks.filter((l) => l.from === selBuilding.id).map((l) => (
              <button key={l.to} type="button" className="mp-link" onClick={() => selectBuilding(l.to)}>{city.buildings[l.to].title} ({city.buildings[l.to].gates.length} gate{city.buildings[l.to].gates.length === 1 ? "" : "s"})</button>
            ))}
          </div>
          <div className="cy-actions">
            <button type="button" className="btn-sm cy-primary" onClick={() => flyBox(selBuilding.box, 1.5)}>Focus on map</button>
          </div>
        </aside>
      )}

      {selBuilding && selBuilding.kind !== "entry" && city && (
        <aside className="mp-detail tl-detail cy-panel" aria-label="Building details">
          <div className="cy-phead">
            <div>
              <div className="cy-pkind">{selBuilding.kind === "vault" ? "PERSISTENCE VAULT" : selBuilding.kind === "outskirts" ? "UNTAGGED BUILDING" : "OPERATIONAL BUILDING"}</div>
              <div className="cy-pname">{selBuilding.title}</div>
            </div>
            <button type="button" className="btn-icon" onClick={clear} aria-label="Close details" title="Close (Esc)">✕</button>
          </div>
          <h4>Source location</h4>
          <code className="cy-file">{selBuilding.file}</code>
          <div className="cy-tags">
            <span className="cy-tag">District: {city.districts.find((d) => d.id === selBuilding.district)?.name}</span>
            <StatusBadge health={selBuilding.health} />
          </div>
          <h4>Function / operation role</h4>
          <p className="mp-purpose">
            {selBuilding.rooms.find((r) => r.role === "main" && r.purpose)?.purpose
              ?? selBuilding.rooms.find((r) => r.purpose)?.purpose
              ?? <span className="muted">{selBuilding.kind === "outskirts" ? "Untagged. Run /telelog in Claude Code." : "No purpose written yet."}</span>}
          </p>
          {selBuilding.gates.length > 0 && (
            <>
              <h4>Endpoints: gates ({selBuilding.gates.length})</h4>
              {(() => {
                const g = selBuilding.gates.find((x) => x.fn === activeRoom);
                return g ? (
                  <div className="cy-endpoint">
                    <div className="cy-gatehead"><span className="cy-gm" style={{ background: methodColor(g.method) }}>{g.method}</span><code>{g.path}</code></div>
                    <div className="cy-rdesc">handler {shortName(g.fn)}{data?.functions[g.fn]?.purpose ? `: ${data.functions[g.fn].purpose}` : ""}</div>
                    <button type="button" className="btn-sm cy-primary" onClick={() => void startRun(g.fn)}>▶ Run flow</button>
                    <span className="cy-rdesc"> watch the request travel down through the functions it calls</span>
                  </div>
                ) : selBuilding.gates.length ? <div className="cy-rdesc">Select an endpoint above to run its flow.</div> : null;
              })()}
              <div className="cy-rooms">
                {selBuilding.gates.map((g) => (
                  <button key={`${g.method}${g.path}`} type="button" className={`cy-roomcard ${g.fn === activeRoom ? "on" : ""}`} onClick={() => setRoomFn(g.fn)}>
                    <span className="cy-gatehead"><span className="cy-gm" style={{ background: methodColor(g.method) }}>{g.method}</span><code>{g.path}</code></span>
                    <span className="cy-rdesc">
                      handler {shortName(g.fn)}{g.status ? ` · status ${g.status}` : ""}{g.response ? ` · returns ${g.response}` : ""}{g.deps.length ? ` · needs ${g.deps.join(", ")}` : ""}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
          <h4>Internal rooms ({selBuilding.rooms.length})</h4>
          <div className="cy-rooms">
            {selBuilding.rooms.map((rm) => (
              <button key={rm.id} type="button" className={`cy-roomcard ${rm.id === activeRoom ? "on" : ""}`} onClick={() => setRoomFn(rm.id)}>
                <span className="cy-rsig">{clip(rm.signature ?? rm.name, 48)}</span>
                <span className="cy-rdesc">{rm.purpose ?? (rm.health === "untagged" ? "untagged" : "")}</span>
                <span className="cy-rmeta">
                  {rm.role && <span className={`tl-role tl-role-${rm.role}`}>{rm.role}</span>}
                  {rm.health !== "ok" && <span className={`tl-health tl-health-${rm.health}`}>{rm.health}</span>}
                </span>
              </button>
            ))}
          </div>
          {city.streets.some((st) => st.a === selBuilding.id || st.b === selBuilding.id) && (
            <>
              <h4>Connections</h4>
              <div className="cy-conns">
                {city.streets.filter((st) => st.a === selBuilding.id || st.b === selBuilding.id).map((st) => {
                  const other = city.buildings[st.a === selBuilding.id ? st.b : st.a];
                  return (
                    <div key={st.id} className="cy-conn">
                      <button type="button" className="mp-link" onClick={() => setSel({ kind: "street", id: st.id })}>{other.title}</button>
                      <span className="cy-rdesc"> {st.count} call{st.count === 1 ? "" : "s"}</span>
                      <ul>
                        {st.links.slice(0, 6).map((l) => {
                          const out = city.byFn[l.from] === selBuilding.id;
                          const mine = out ? l.from : l.to;
                          return (
                            <li key={`${l.from}>${l.to}`} className={mine === activeRoom ? "on" : ""}>
                              <button type="button" className="cy-pairbtn" onClick={() => selectBuilding(other.id, out ? l.to : l.from)}>
                                {shortName(l.from)} → {shortName(l.to)}{l.n > 1 ? ` ×${l.n}` : ""}
                              </button>
                              <span className="cy-dir">{out ? "calls out" : "called by"}</span>
                            </li>
                          );
                        })}
                        {st.links.length > 6 && <li className="cy-rdesc">+{st.links.length - 6} more</li>}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {activeRoom && data?.functions[activeRoom] && (
            <>
              <FieldTable title="Incoming data" fields={data.functions[activeRoom].inputs} live={live?.inputs} />
              <FieldTable title="Outgoing data" fields={data.functions[activeRoom].outputs} live={live?.outputs} />
              {live && live.status === "no-trace" && <p className="tl-note">No trace yet. Arm this function in Terminal and send a request.</p>}
            </>
          )}
          {selBuilding.kind !== "vault" && (
            <>
              <h4>Implementation preview</h4>
              <pre className="cy-code">{codeNow ? codeNow.text : "// loading…"}{codeNow?.truncated ? "\n// … (capped)" : ""}</pre>
            </>
          )}
          <h4>Connected highways</h4>
          {roadsOf(selBuilding).length ? (
            <div className="cy-links">
              {roadsOf(selBuilding).map((r) => (
                <button key={r.id} type="button" className="mp-link" onClick={() => { setSel({ kind: "road", id: r.id }); setHot(new Set([r.id])); }}>{r.name}</button>
              ))}
            </div>
          ) : <div className="muted">Local district network</div>}
          <div className="cy-actions">
            <button type="button" className="btn-sm cy-primary" onClick={() => flyBox(selBuilding.box, 1.5)}>Focus on map</button>
            <button type="button" className="btn-sm" disabled={!selBuilding.roads.length} onClick={() => setHot(hot ? null : new Set(selBuilding.roads))}>
              {hot ? "Clear highlight" : "Highlight route"}
            </button>
          </div>
        </aside>
      )}

      {selDistrict && city && (
        <aside className="mp-detail tl-detail cy-panel" aria-label="District details">
          <div className="cy-phead">
            <div>
              <div className="cy-pkind">DISTRICT</div>
              <div className="cy-pname">{selDistrict.name}</div>
            </div>
            <button type="button" className="btn-icon" onClick={clear} aria-label="Close details">✕</button>
          </div>
          <p className="mp-purpose">{selDistrict.desc}</p>
          <h4>Buildings ({selDistrict.buildings.length})</h4>
          <div className="cy-links">
            {selDistrict.buildings.map((id) => (
              <button key={id} type="button" className="mp-link" onClick={() => selectBuilding(id)}>{city.buildings[id].title}</button>
            ))}
          </div>
          <div className="cy-actions">
            <button type="button" className="btn-sm cy-primary" onClick={() => flyBox(selDistrict.box, 0.8)}>Focus on map</button>
          </div>
        </aside>
      )}

      {selStreet && city && (
        <aside className="mp-detail tl-detail cy-panel" aria-label="Street details">
          <div className="cy-phead">
            <div>
              <div className="cy-pkind">STREET</div>
              <div className="cy-pname">{city.buildings[selStreet.a].title} ↔ {city.buildings[selStreet.b].title}</div>
            </div>
            <button type="button" className="btn-icon" onClick={clear} aria-label="Close details">✕</button>
          </div>
          <p className="mp-purpose">
            {selStreet.count} function call{selStreet.count === 1 ? "" : "s"} cross this street:{" "}
            {selStreet.ab} from {city.buildings[selStreet.a].title}, {selStreet.ba} from {city.buildings[selStreet.b].title}.
          </p>
          <h4>Function connections ({selStreet.links.length})</h4>
          <div className="cy-rooms">
            {selStreet.links.map((l) => (
              <div key={`${l.from}>${l.to}`} className="cy-roomcard">
                <span className="cy-rsig">{shortName(l.from)} → {shortName(l.to)}{l.n > 1 ? ` ×${l.n}` : ""}</span>
                <span className="cy-rdesc">
                  {data?.functions[l.from]?.purpose ? `${shortName(l.from)}: ${data.functions[l.from].purpose}` : ""}
                </span>
                <span className="cy-rmeta">
                  <button type="button" className="mp-link" onClick={() => selectBuilding(city.byFn[l.from], l.from)}>{city.buildings[city.byFn[l.from]].title}</button>
                  <span className="cy-dir">→</span>
                  <button type="button" className="mp-link" onClick={() => selectBuilding(city.byFn[l.to], l.to)}>{city.buildings[city.byFn[l.to]].title}</button>
                </span>
              </div>
            ))}
          </div>
        </aside>
      )}

      {selRoad && city && (
        <aside className="mp-detail tl-detail cy-panel" aria-label="Highway details">
          <div className="cy-phead">
            <div>
              <div className="cy-pkind">HIGHWAY</div>
              <div className="cy-pname">{selRoad.name}</div>
            </div>
            <button type="button" className="btn-icon" onClick={clear} aria-label="Close details">✕</button>
          </div>
          {selRoad.route && <code className="cy-file">{selRoad.route}</code>}
          <h4>Stops ({selRoad.steps.length})</h4>
          <ol className="cy-steps">
            {selRoad.steps.map((s) => (
              <li key={s.fn}>
                <button type="button" className="mp-link" onClick={() => selectBuilding(s.building, s.fn)}>{s.title.replace(/^\d+\.\s*/, "")}</button>
                <div className="cy-rdesc">{s.desc}</div>
              </li>
            ))}
          </ol>
          <div className="cy-actions">
            <button type="button" className="btn-sm cy-primary" onClick={() => void startRun(selRoad.main)}>▶ Run flow</button>
            <button type="button" className="btn-sm" onClick={() => startTour(selRoad.id)}>Start tour</button>
          </div>
        </aside>
      )}
    </div>
  );
}

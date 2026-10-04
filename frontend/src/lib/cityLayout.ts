/* cityLayout.ts — the project as a city (see project_map.html in the Arthur repo for the look).
     district  = a feature                       (colored zone)
     building  = a module that holds tagged code  (card: file, "N rooms")
     room      = a tagged function in that module
     highway   = a flow: an endpoint's main function plus its steps, joined through the buildings they sit in
     vault     = a database table, in the storage district
     tour      = a highway walked step by step
   Pure: the same payload always gives the same city. No React, no DOM. */

import type { TelelogFn, TelelogMapData } from "./mapApi";
import type { Box } from "./mapLayout";

export type Health = "ok" | "stale" | "invalid" | "untagged";

export interface Room {
  id: string;
  name: string;
  role: "main" | "sub" | "helper" | null;
  purpose: string | null;
  signature: string | null;
  health: Health;
}

export interface Gate {
  method: string;
  path: string;
  fn: string;
  status: string | null;
  response: string | null;
  deps: string[];
}

export interface Building {
  id: string;
  district: string;
  module: string;
  title: string;
  file: string;
  kind: "building" | "vault" | "outskirts" | "entry";
  rooms: Room[];
  /** endpoints whose handler lives in this building: where highways begin */
  gates: Gate[];
  box: Box;
  health: Health;
  roads: string[];
}

export interface District {
  id: string;
  name: string;
  kind: "feature" | "storage" | "outskirts" | "gateway";
  color: string;
  box: Box;
  desc: string;
  buildings: string[];
}

export interface Step {
  fn: string;
  building: string;
  title: string;
  desc: string;
}

export interface Road {
  id: string;
  main: string;
  name: string;
  route: string | null;
  color: string;
  points: { x: number; y: number }[];
  buildings: string[];
  steps: Step[];
  gate: { method: string; path: string } | null;
  /** the road drawn along the streets this flow crosses, building to building */
  /** where the road leaves its first building: the gate marker sits here */
  start: { x: number; y: number } | null;
  label: { x: number; y: number; text: string; w: number } | null;
}

export interface Pt {
  x: number;
  y: number;
}

/** One function calling another, across two buildings. */
export interface Link {
  from: string;
  to: string;
  n: number;
  edge: string;
}

/** The road between two buildings: every function call that crosses it, in both directions. */
export interface Street {
  id: string;
  a: string;
  b: string;
  links: Link[];
  count: number;
  /** call sites a to b, and b to a */
  ab: number;
  ba: number;
  points: Pt[];
  width: number;
  arrows: { x: number; y: number; angle: number }[];
}

export interface Pipe {
  from: string;
  to: string;
  mode: string;
}

export type SearchKind = "building" | "road" | "district" | "room";
export interface SearchItem {
  kind: SearchKind;
  id: string;
  title: string;
  sub: string;
  /** the building (or district / road) to fly to */
  target: string;
  fn?: string;
}

export interface City {
  districts: District[];
  buildings: Record<string, Building>;
  roads: Road[];
  pipes: Pipe[];
  streets: Street[];
  entryLinks: { from: string; to: string }[];
  bounds: Box;
  byFn: Record<string, string>;
  search: SearchItem[];
}

export const BW = 160;
export const BH = 164;
const GAP = 76;
const PAD = 30;
const HEAD = 62;
const DGAP = 60;
const TARGET_ASPECT = 1.9;
export const PALETTE = ["#1976d2", "#7b1fa2", "#c2185b", "#2e7d32", "#00796b", "#e65100", "#5d4037", "#0097a7"];
const ROAD_COLORS = ["#ffb300", "#ff6f00", "#f9a825", "#fb8c00", "#fdd835", "#ffa000"];
const OUTSKIRTS = "#78909c";
const STORAGE = "#455a64";

export const shortName = (id: string) => id.slice(id.indexOf(":") + 1);

export function clip(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

/** "app.api.routes_lattice" -> "Routes Lattice"; a package's __init__ takes the package name. */
export function moduleTitle(module: string): string {
  const parts = module.split(".");
  let last = parts[parts.length - 1];
  if (last === "__init__" && parts.length > 1) last = parts[parts.length - 2];
  return last.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim() || module;
}

export const METHOD_COLOR: Record<string, string> = {
  GET: "#2e7d32", POST: "#1565c0", PUT: "#ef6c00", PATCH: "#ef6c00", DELETE: "#c62828", WS: "#6a1b9a",
};
export const methodColor = (m: string) => METHOD_COLOR[m.toUpperCase()] ?? "#546e7a";

/** "/organisms/{id}/predict" -> "…/{id}/predict": keeps the end, which is what tells endpoints apart. */
export function shortPath(path: string, max: number): string {
  if (path.length <= max) return path;
  const segs = path.split("/").filter(Boolean);
  let out = "";
  for (let i = segs.length - 1; i >= 0; i--) {
    const next = `/${segs[i]}${out}`;
    if (next.length + 1 > max) break;
    out = next;
  }
  return `…${out || `/${segs[segs.length - 1]}`.slice(-(max - 1))}`;
}

const ROLE_RANK: Record<string, number> = { main: 0, sub: 1, helper: 2 };

const worst = (hs: Health[]): Health =>
  hs.includes("invalid") ? "invalid" : hs.includes("stale") ? "stale" : hs.includes("untagged") && hs.every((h) => h === "untagged") ? "untagged" : "ok";

function room(fn: TelelogFn): Room {
  return { id: fn.id, name: shortName(fn.id), role: fn.role, purpose: fn.purpose, signature: fn.signature, health: fn.status };
}

/** The steps of a flow, depth first: the main, each non-helper child in `n` order, then that child's own steps. */
export function flowFunctions(main: string, data: TelelogMapData, seen = new Set<string>()): TelelogFn[] {
  const fn = data.functions[main];
  if (!fn || seen.has(main)) return [];
  seen.add(main);
  const out = [fn];
  for (const c of data.children[main] ?? []) {
    const child = data.functions[c];
    if (child && child.role !== "helper") out.push(...flowFunctions(c, data, seen));
  }
  return out;
}

function stepDesc(fn: TelelogFn): string {
  const parts: string[] = [];
  if (fn.purpose && fn.purpose !== "?") parts.push(fn.purpose.replace(/\.$/, "") + ".");
  const ins = (fn.inputs ?? []).map((f) => f.name);
  const outs = (fn.outputs ?? []).map((f) => f.name);
  if (ins.length) parts.push(`It receives ${ins.join(", ")}.`);
  if (outs.length) parts.push(`It returns ${outs.join(", ")}.`);
  return parts.join(" ") || "No description written yet.";
}

type Side = "L" | "R" | "T" | "B";
type Shape = "hvh" | "vhv" | "hv";
const bcx = (b: Building) => b.box.x + BW / 2;
const bcy = (b: Building) => b.box.y + BH / 2;
export const streetKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Which sides of two buildings a road should leave and enter, and how it bends. */
function chooseRoute(A: Building, B: Building): { a: Side; b: Side; shape: Shape } {
  const dx = bcx(B) - bcx(A), dy = bcy(B) - bcy(A);
  if (Math.abs(dy) <= BH * 0.55) return { a: dx > 0 ? "R" : "L", b: dx > 0 ? "L" : "R", shape: "hvh" };
  if (Math.abs(dx) <= BW * 0.55) return { a: dy > 0 ? "B" : "T", b: dy > 0 ? "T" : "B", shape: "vhv" };
  return { a: dx > 0 ? "R" : "L", b: dy > 0 ? "T" : "B", shape: "hv" };
}

function portAt(b: Building, side: Side, off: number): Pt {
  switch (side) {
    case "R": return { x: b.box.x + BW, y: bcy(b) + off };
    case "L": return { x: b.box.x, y: bcy(b) + off };
    case "T": return { x: bcx(b) + off, y: b.box.y };
    default: return { x: bcx(b) + off, y: b.box.y + BH };
  }
}

function routePoints(A: Building, B: Building, r: { a: Side; b: Side; shape: Shape }, offA: number, offB: number): Pt[] {
  const p = portAt(A, r.a, offA), q = portAt(B, r.b, offB);
  if (r.shape === "hvh") { const mx = (p.x + q.x) / 2; return [p, { x: mx, y: p.y }, { x: mx, y: q.y }, q]; }
  if (r.shape === "vhv") { const my = (p.y + q.y) / 2; return [p, { x: p.x, y: my }, { x: q.x, y: my }, q]; }
  return [p, { x: q.x, y: p.y }, q];
}

const CLEAR = 6;

/** Straight axis-aligned run p-q does not touch any building except the two it joins. */
function runClear(p: Pt, q: Pt, rects: { id: string; x0: number; y0: number; x1: number; y1: number }[], skip: string[]): boolean {
  const x0 = Math.min(p.x, q.x), x1 = Math.max(p.x, q.x), y0 = Math.min(p.y, q.y), y1 = Math.max(p.y, q.y);
  return !rects.some((r) => !skip.includes(r.id) && x1 > r.x0 - CLEAR && x0 < r.x1 + CLEAR && y1 > r.y0 - CLEAR && y0 < r.y1 + CLEAR);
}

const bends = (pts: Pt[]) => Math.max(0, pts.length - 2);
const length = (pts: Pt[]) => pts.reduce((n, p, i) => (i ? n + Math.abs(p.x - pts[i - 1].x) + Math.abs(p.y - pts[i - 1].y) : 0), 0);

/** The cheapest route between two buildings that does not run behind a third one: tries the simple bend first, then
 *  bends placed in the gutters between buildings, then a channel route along a gutter. Falls back to the simple bend. */
function findRoute(
  A: Building, B: Building, r: { a: Side; b: Side; shape: Shape }, offA: number, offB: number,
  rects: { id: string; x0: number; y0: number; x1: number; y1: number }[], gx: number[], gy: number[],
): Pt[] {
  const simple = routePoints(A, B, r, offA, offB);
  const p = simple[0], q = simple[simple.length - 1];
  const skip = [A.id, B.id];
  const ok = (pts: Pt[]) => pts.every((pt, i) => !i || (pt.x === pts[i - 1].x || pt.y === pts[i - 1].y) && runClear(pts[i - 1], pt, rects, skip));
  if (ok(simple)) return simple;
  const g = GAP / 2;
  const cands: Pt[][] = [];
  const near = (vals: number[], to: number, n = 10) => [...vals].sort((u, v) => Math.abs(u - to) - Math.abs(v - to)).slice(0, n);
  if (r.shape === "hvh") for (const mx of near(gx, (p.x + q.x) / 2)) cands.push([p, { x: mx, y: p.y }, { x: mx, y: q.y }, q]);
  if (r.shape === "vhv") for (const my of near(gy, (p.y + q.y) / 2)) cands.push([p, { x: p.x, y: my }, { x: q.x, y: my }, q]);
  if (r.shape === "hv") {
    const gyB = r.b === "T" ? q.y - g : q.y + g;
    for (const mx of near(gx, (p.x + q.x) / 2)) cands.push([p, { x: mx, y: p.y }, { x: mx, y: gyB }, { x: q.x, y: gyB }, q]);
  }
  if (r.a === "L" || r.a === "R") {
    const sx = p.x + (r.a === "R" ? g : -g);
    const ex = q.x + (r.b === "R" ? g : r.b === "L" ? -g : 0);
    for (const my of [...near(gy, p.y, 6), ...near(gy, q.y, 6)]) {
      cands.push(r.b === "L" || r.b === "R"
        ? [p, { x: sx, y: p.y }, { x: sx, y: my }, { x: ex, y: my }, { x: ex, y: q.y }, q]
        : [p, { x: sx, y: p.y }, { x: sx, y: my }, { x: q.x, y: my }, q]);
    }
  } else {
    const sy = p.y + (r.a === "B" ? g : -g);
    const ey = q.y + (r.b === "B" ? g : r.b === "T" ? -g : 0);
    for (const mx of [...near(gx, p.x, 6), ...near(gx, q.x, 6)]) {
      cands.push(r.b === "T" || r.b === "B"
        ? [p, { x: p.x, y: sy }, { x: mx, y: sy }, { x: mx, y: ey }, { x: q.x, y: ey }, q]
        : [p, { x: p.x, y: sy }, { x: mx, y: sy }, { x: mx, y: q.y }, q]);
    }
  }
  cands.sort((u, v) => length(u) + 60 * bends(u) - (length(v) + 60 * bends(v)));
  return cands.find(ok) ?? simple;
}

/** Chevrons on the longest straight stretch, pointing the way calls go (both ways for a two-way street). */
function arrowsFor(points: Pt[], ab: number, ba: number): { x: number; y: number; angle: number }[] {
  let best = { len: -1, a: points[0], b: points[points.length - 1] };
  for (let i = 1; i < points.length; i++) {
    const len = Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
    if (len > best.len) best = { len, a: points[i - 1], b: points[i] };
  }
  const angle = (Math.atan2(best.b.y - best.a.y, best.b.x - best.a.x) * 180) / Math.PI;
  const mx = (best.a.x + best.b.x) / 2, my = (best.a.y + best.b.y) / 2;
  const ux = best.len ? (best.b.x - best.a.x) / best.len : 0, uy = best.len ? (best.b.y - best.a.y) / best.len : 0;
  if (ab && ba) return [{ x: mx - ux * 12, y: my - uy * 12, angle }, { x: mx + ux * 12, y: my + uy * 12, angle: angle + 180 }];
  return [{ x: mx, y: my, angle: ba && !ab ? angle + 180 : angle }];
}

/** Path with rounded corners, so a road reads as a road and not a wire. */
export function roundedPath(points: Pt[], r = 16): string {
  if (points.length < 3) return pathOf(points);
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i - 1], c = points[i], n = points[i + 1];
    const l1 = Math.hypot(c.x - p.x, c.y - p.y), l2 = Math.hypot(n.x - c.x, n.y - c.y);
    const k = Math.min(r, l1 / 2, l2 / 2);
    if (k < 1) { d += ` L${c.x},${c.y}`; continue; }
    d += ` L${c.x - ((c.x - p.x) / l1) * k},${c.y - ((c.y - p.y) / l1) * k}`;
    d += ` Q${c.x},${c.y} ${c.x + ((n.x - c.x) / l2) * k},${c.y + ((n.y - c.y) / l2) * k}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last.x},${last.y}`;
}

export function buildCity(data: TelelogMapData): City {
  const fns = Object.values(data.functions);
  const featureOf = (f: TelelogFn) => f.feature ?? "(no feature)";

  // buildings: one per (feature, module) that holds tagged functions
  const bKey = (feature: string, module: string) => `b:${feature}|${module}`;
  const buildings: Record<string, Building> = {};
  const byFn: Record<string, string> = {};
  for (const f of fns.sort((a, b) => (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0))) {
    const id = bKey(featureOf(f), f.module);
    const b = (buildings[id] ??= {
      id, district: `d:${featureOf(f)}`, module: f.module, title: moduleTitle(f.module), file: f.file ?? f.module,
      kind: "building", rooms: [], gates: [], box: { x: 0, y: 0, w: BW, h: BH }, health: "ok", roads: [],
    });
    b.rooms.push(room(f));
    for (const e of f.endpoints ?? []) {
      b.gates.push({ method: e.method, path: e.path, fn: f.id, status: e.status_code, response: e.response_model, deps: e.dependencies });
    }
    byFn[f.id] = id;
  }
  for (const b of Object.values(buildings)) {
    b.rooms.sort((a, c) => (ROLE_RANK[a.role ?? ""] ?? 3) - (ROLE_RANK[c.role ?? ""] ?? 3) || a.name.localeCompare(c.name));
    b.gates.sort((a, c) => a.path.localeCompare(c.path) || a.method.localeCompare(c.method));
  }

  // untagged modules live in the outskirts, one dashed building each
  const outskirts = Object.entries(data.untagged);
  for (const [module, ids] of outskirts) {
    const id = `b:untagged|${module}`;
    buildings[id] = {
      id, district: "d:outskirts", module, title: moduleTitle(module), file: data.files?.[module] ?? module, kind: "outskirts",
      rooms: ids.map((fid) => ({ id: fid, name: shortName(fid), role: null, purpose: null, signature: null, health: "untagged" as Health })),
      gates: [], box: { x: 0, y: 0, w: BW, h: BH }, health: "untagged", roads: [],
    };
    for (const fid of ids) byFn[fid] = id;
  }

  // vaults: one per table touched by tagged code, listing who reads and writes it
  const tables = new Map<string, { fn: TelelogFn; mode: string }[]>();
  for (const f of fns) for (const d of f.db ?? []) tables.set(d.table, [...(tables.get(d.table) ?? []), { fn: f, mode: d.mode }]);
  const pipes: Pipe[] = [];
  for (const [table, users] of [...tables].sort((a, b) => a[0].localeCompare(b[0]))) {
    const id = `b:vault|${table}`;
    buildings[id] = {
      id, district: "d:storage", module: table, title: table, file: "database table", kind: "vault",
      rooms: users.map(({ fn, mode }) => ({ id: fn.id, name: shortName(fn.id), role: fn.role, purpose: mode === "r" ? "reads" : mode === "w" ? "writes" : "reads and writes", signature: null, health: fn.status })),
      gates: [], box: { x: 0, y: 0, w: BW, h: BH }, health: "ok", roads: [],
    };
    for (const { fn, mode } of users) {
      const from = byFn[fn.id];
      if (from) pipes.push({ from, to: id, mode });
    }
  }
  for (const b of Object.values(buildings)) b.health = b.kind === "building" ? worst(b.rooms.map((r) => r.health)) : b.health;

  // districts
  const names = [...new Set(fns.map(featureOf))].sort();
  const districts: District[] = names.map((name, i) => {
    const feat = data.features.find((f) => f.name === name);
    const mains = (feat?.mains ?? []).map((m) => data.functions[m]?.purpose).filter((p): p is string => !!p && p !== "?");
    return {
      id: `d:${name}`, name, kind: "feature", color: PALETTE[i % PALETTE.length], box: { x: 0, y: 0, w: 0, h: 0 }, buildings: [],
      desc: mains.length ? mains.slice(0, 3).join(" ") : `${feat?.functions ?? 0} tagged functions.`,
    };
  });
  if (outskirts.length) {
    districts.push({
      id: "d:outskirts", name: "Untagged Outskirts", kind: "outskirts", color: OUTSKIRTS, box: { x: 0, y: 0, w: 0, h: 0 }, buildings: [],
      desc: "Code nobody has described yet. Run /telelog in Claude Code to build it out.",
    });
  }
  if (tables.size) {
    districts.push({
      id: "d:storage", name: "Persistence Vaults", kind: "storage", color: STORAGE, box: { x: 0, y: 0, w: 0, h: 0 }, buildings: [],
      desc: "Database tables touched by tagged code, with who reads and writes each.",
    });
  }
  // the API gateway: one building per app / app factory, linked to every building that holds endpoints
  const gatewayBuildings = Object.values(buildings).filter((b) => b.gates.length);
  if (data.entry_points?.length) {
    districts.unshift({
      id: "d:gateway", name: "API Gateway", kind: "gateway", color: "#1976d2", box: { x: 0, y: 0, w: 0, h: 0 }, buildings: [],
      desc: `Where ${data.endpoint_count} endpoint${data.endpoint_count === 1 ? "" : "s"} enter. Each highway starts at a gate on the building that handles it.`,
    });
    for (const ep of data.entry_points) {
      const id = `b:entry|${ep.id}`;
      buildings[id] = {
        id, district: "d:gateway", module: ep.module, title: `${ep.framework ?? "App"} ${ep.kind === "factory" ? "factory" : "app"}`,
        file: ep.file_path ?? ep.module, kind: "entry", rooms: [], gates: [], box: { x: 0, y: 0, w: BW, h: BH }, health: "ok", roads: [],
      };
    }
  }
  const entryLinks = Object.values(buildings).filter((b) => b.kind === "entry")
    .flatMap((e) => gatewayBuildings.map((g) => ({ from: e.id, to: g.id })));
  for (const b of Object.values(buildings)) districts.find((d) => d.id === b.district)?.buildings.push(b.id);
  for (const d of districts) d.buildings.sort((a, b) => buildings[a].title.localeCompare(buildings[b].title));

  // layout: buildings in a grid inside each district, districts packed in rows; storage runs along the bottom
  const gridCols = (n: number, max: number) => Math.max(1, Math.min(max, Math.ceil(Math.sqrt(n))));
  for (const d of districts) {
    const cols = gridCols(d.buildings.length, d.kind === "storage" ? 8 : 3);
    const rows = Math.ceil(d.buildings.length / cols) || 1;
    d.box.w = Math.max(Math.max(cols, 1) * BW + (cols - 1) * GAP + PAD * 2, d.name.length * 17 + PAD * 2);
    d.box.h = rows * BH + (rows - 1) * GAP + HEAD + PAD;
    d.buildings.forEach((id, i) => {
      const b = buildings[id];
      b.box = { x: PAD + (i % cols) * (BW + GAP), y: HEAD + Math.floor(i / cols) * (BH + GAP), w: BW, h: BH };
    });
  }
  const rest = districts.filter((d) => d.kind !== "storage" && d.kind !== "gateway").sort((a, b) => b.box.h - a.box.h || a.name.localeCompare(b.name));
  const placed = [...districts.filter((d) => d.kind === "gateway"), ...rest];
  // pack towards a landscape city: the row width follows the total area, never narrower than the widest district
  const area = placed.reduce((n, d) => n + (d.box.w + DGAP) * (d.box.h + DGAP), 0);
  const rowW = Math.max(...placed.map((d) => d.box.w), Math.sqrt(area * TARGET_ASPECT));
  let x = 0, y = 0, rowH = 0;
  for (const d of placed) {
    if (x > 0 && x + d.box.w > rowW) { x = 0; y += rowH + DGAP; rowH = 0; }
    d.box.x = x; d.box.y = y;
    x += d.box.w + DGAP; rowH = Math.max(rowH, d.box.h);
  }
  const usedW = Math.max(0, ...placed.map((d) => d.box.x + d.box.w));
  const storage = districts.find((d) => d.kind === "storage");
  const topBottom = placed.length ? y + rowH : 0;
  if (storage) {
    const cols = Math.max(1, Math.min(storage.buildings.length, Math.floor((Math.max(usedW, BW + PAD * 2) - PAD * 2 + GAP) / (BW + GAP))));
    const rows = Math.ceil(storage.buildings.length / cols);
    storage.box.w = Math.max(usedW, cols * BW + (cols - 1) * GAP + PAD * 2);
    storage.box.h = rows * BH + (rows - 1) * GAP + HEAD + PAD;
    storage.buildings.forEach((id, i) => {
      buildings[id].box = { x: PAD + (i % cols) * (BW + GAP), y: HEAD + Math.floor(i / cols) * (BH + GAP), w: BW, h: BH };
    });
    storage.box.x = 0; storage.box.y = topBottom + DGAP;
  }
  for (const d of districts) {
    d.buildings.forEach((id) => {
      const b = buildings[id];
      b.box = { ...b.box, x: d.box.x + b.box.x, y: d.box.y + b.box.y };
    });
  }
  const right = Math.max(0, ...districts.map((d) => d.box.x + d.box.w));
  const bottom = Math.max(0, ...districts.map((d) => d.box.y + d.box.h));
  const bounds: Box = { x: 0, y: 0, w: right, h: bottom };

  // streets: every function call that crosses from one building to another, merged per building pair
  const pairs = new Map<string, { a: string; b: string; links: Link[] }>();
  for (const [caller, list] of Object.entries(data.calls ?? {})) {
    const from = byFn[caller];
    for (const c of list) {
      const to = byFn[c.to];
      if (!from || !to || from === to) continue;
      const key = streetKey(from, to);
      const e = pairs.get(key) ?? { a: from < to ? from : to, b: from < to ? to : from, links: [] };
      e.links.push({ from: caller, to: c.to, n: c.n, edge: c.edge });
      pairs.set(key, e);
    }
  }
  const routes = new Map<string, { a: Side; b: Side; shape: Shape }>();
  const portUsers = new Map<string, { key: string; sort: number }[]>();
  const addPort = (b: Building, side: Side, key: string, other: Building) => {
    const k = `${b.id}#${side}`;
    portUsers.set(k, [...(portUsers.get(k) ?? []), { key, sort: side === "L" || side === "R" ? bcy(other) : bcx(other) }]);
  };
  for (const [key, e] of [...pairs].sort((x, y) => x[0].localeCompare(y[0]))) {
    const A = buildings[e.a], B = buildings[e.b];
    const r = chooseRoute(A, B);
    routes.set(key, r);
    addPort(A, r.a, key, B);
    addPort(B, r.b, key, A);
  }
  const offsetOf = (b: Building, side: Side, key: string) => {
    const users = (portUsers.get(`${b.id}#${side}`) ?? []).sort((x, y) => x.sort - y.sort || x.key.localeCompare(y.key));
    const i = users.findIndex((u) => u.key === key);
    const len = side === "L" || side === "R" ? BH : BW;
    const step = Math.min(18, (len - 40) / Math.max(1, users.length - 1 || 1));
    return users.length > 1 ? (i - (users.length - 1) / 2) * step : 0;
  };
  const rects = Object.values(buildings).map((b) => ({ id: b.id, x0: b.box.x, y0: b.box.y, x1: b.box.x + BW, y1: b.box.y + BH }));
  const uniq = (v: number[]) => [...new Set(v.map((n) => Math.round(n)))].sort((p, q) => p - q);
  const gx = uniq(rects.flatMap((r) => [r.x1 + GAP / 2, r.x0 - GAP / 2]));
  const gy = uniq(rects.flatMap((r) => [r.y1 + GAP / 2, r.y0 - GAP / 2]));
  const streets: Street[] = [];
  const streetByKey = new Map<string, Street>();
  for (const [key, e] of pairs) {
    const A = buildings[e.a], B = buildings[e.b], r = routes.get(key)!;
    const points = findRoute(A, B, r, offsetOf(A, r.a, key), offsetOf(B, r.b, key), rects, gx, gy);
    let ab = 0, ba = 0;
    for (const l of e.links) if (byFn[l.from] === e.a) ab += l.n; else ba += l.n;
    const count = ab + ba;
    const st: Street = {
      id: `s:${key}`, a: e.a, b: e.b, links: e.links.sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to)),
      count, ab, ba, points, width: 9 + Math.min(9, Math.round(Math.log2(count + 1) * 2.2)), arrows: arrowsFor(points, ab, ba),
    };
    streets.push(st);
    streetByKey.set(key, st);
  }

  // highways: the flow of every endpoint (or main with steps), drawn along the streets it crosses, building to building
  const roads: Road[] = [];
  const mains = fns.filter((f) => f.role === "main" || (f.role === null && !f.parent)).sort((a, b) => a.id.localeCompare(b.id));
  let idx = 0;
  for (const m of mains) {
    const flow = flowFunctions(m.id, data);
    const bs: string[] = [];
    for (const f of flow) {
      const b = byFn[f.id];
      if (b && bs[bs.length - 1] !== b) bs.push(b);
    }
    if (!m.routes.length && flow.length < 2) continue;
    const points: Pt[] = [];
    for (let i = 1; i < bs.length; i++) {
      const A = buildings[bs[i - 1]], B = buildings[bs[i]];
      const st = streetByKey.get(streetKey(A.id, B.id));
      const seg = st ? (st.a === A.id ? st.points : [...st.points].reverse()) : findRoute(A, B, chooseRoute(A, B), 0, 0, rects, gx, gy);
      points.push(...seg);
    }
    const route = m.routes[0] ?? null;
    const ep = m.endpoints[0];
    roads.push({
      id: `r:${m.id}`, main: m.id, name: route ? `Highway ${route.split(" ").slice(1).join(" ") || route}` : `Route ${shortName(m.id)}`,
      route, color: ROAD_COLORS[idx % ROAD_COLORS.length], points, buildings: bs,
      steps: flow.map((f, i) => ({ fn: f.id, building: byFn[f.id], title: `${i + 1}. ${shortName(f.id)}`, desc: stepDesc(f) })),
      gate: ep ? { method: ep.method, path: ep.path } : null, start: points[0] ?? null, label: null,
    });
    for (const id of bs) buildings[id].roads.push(`r:${m.id}`);
    idx++;
  }

  // road labels: at each road's longest visible stretch; labels that would land on one another stack upwards
  const placedLabels: { x0: number; x1: number; y: number }[] = [];
  for (const r of roads) {
    if (r.points.length < 2) continue;
    let best = { len: -1, x: 0, y: 0, horizontal: true };
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1], c = r.points[i];
      const horizontal = a.y === c.y;
      const len = Math.abs(a.x - c.x) + Math.abs(a.y - c.y);
      if (len > best.len) best = { len, x: (a.x + c.x) / 2, y: (a.y + c.y) / 2, horizontal };
    }
    const path = r.route?.split(" ").slice(1).join(" ") || r.name;
    const text = best.len > 220 ? r.name : shortPath(path, Math.max(7, Math.floor(best.len / 8)));
    const w = text.length * 7.8;
    let y = best.y - 12;
    while (placedLabels.some((p) => Math.abs(p.y - y) < 14 && p.x0 < best.x + w / 2 && p.x1 > best.x - w / 2)) y -= 15;
    placedLabels.push({ x0: best.x - w / 2, x1: best.x + w / 2, y });
    r.label = { x: best.x, y, text, w };
  }

  const search: SearchItem[] = [];
  for (const d of districts) search.push({ kind: "district", id: d.id, title: d.name, sub: `${d.buildings.length} buildings`, target: d.id });
  for (const r of roads) search.push({ kind: "road", id: r.id, title: r.name, sub: r.route ?? "flow", target: r.id });
  for (const b of Object.values(buildings)) {
    search.push({ kind: "building", id: b.id, title: b.title, sub: b.file, target: b.id });
    for (const rm of b.rooms) if (b.kind !== "vault") search.push({ kind: "room", id: `${b.id}#${rm.id}`, title: rm.name, sub: `${b.title} · ${rm.role ?? "untagged"}`, target: b.id, fn: rm.id });
  }
  return { districts, buildings, roads, pipes, streets, entryLinks, bounds, byFn, search };
}

export function searchCity(city: City, query: string, limit = 10): SearchItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const rank = (s: SearchItem) => (s.title.toLowerCase().startsWith(q) ? 0 : 1) + ({ district: 0, road: 0.1, building: 0.2, room: 0.3 }[s.kind]);
  return city.search
    .filter((s) => s.title.toLowerCase().includes(q) || s.sub.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, limit);
}

/** Camera that centres `box` in a viewport of the given size at `zoom`. */
export function cameraFor(box: Box, vw: number, vh: number, zoom: number, rightInset = 0): { x: number; y: number; k: number } {
  return { k: zoom, x: (vw - rightInset) / 2 - (box.x + box.w / 2) * zoom, y: vh / 2 - (box.y + box.h / 2) * zoom };
}

export function fitCamera(bounds: Box, vw: number, vh: number): { x: number; y: number; k: number } {
  const k = Math.max(0.12, Math.min(1.1, (vw - 80) / (bounds.w + 80), (vh - 240) / (bounds.h + 80)));
  return { k, x: (vw - bounds.w * k) / 2, y: 170 + Math.max(0, (vh - 240 - bounds.h * k) / 2) };
}

export function pathOf(points: { x: number; y: number }[]): string {
  return points.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
}

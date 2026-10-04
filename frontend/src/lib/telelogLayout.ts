/* telelogLayout.ts — the four levels of the Telelog map as plain data: nodes, edges, boxes.
   Project (features) -> Feature (flows) -> Flow (ordered steps) -> Function (helpers).
   Pure: same payload and level -> same layout. No React, no DOM, so it can be unit-tested. */

import type { TelelogFn, TelelogMapData } from "./mapApi";
import type { Box } from "./mapLayout";

export type Level =
  | { kind: "project" }
  | { kind: "feature"; name: string }
  | { kind: "module"; name: string }
  | { kind: "flow"; main: string }
  | { kind: "function"; id: string };

export type NodeKind = "feature" | "module" | "main" | "sub" | "helper" | "untagged" | "table" | "external";
export type Health = "ok" | "stale" | "invalid" | "untagged";

export interface LNode {
  id: string;
  kind: NodeKind;
  label: string;
  sub?: string;
  detail?: string;
  health: Health;
  box: Box;
  /** where Enter / double-click goes; absent = nothing below */
  drill?: Level;
  /** the function this node stands for (selecting it opens the detail panel) */
  fn?: string;
  aria: string;
}

export interface LEdge {
  from: string;
  to: string;
  label?: string;
  title?: string;
}

export interface LevelView {
  nodes: LNode[];
  edges: LEdge[];
  groups: Box[];
  bounds: Box;
  empty?: string;
}

export const W = 250;
export const H = 84;
const GAP = 24;
const COL_GAP = 120;
const HELPER_W = 190;
const HELPER_H = 36;

const sameLevel = (a: Level, b: Level) => JSON.stringify(a) === JSON.stringify(b);
export { sameLevel };

export const shortName = (id: string) => id.slice(id.indexOf(":") + 1);

export function clip(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

/** Up to two names, then "+N"; the full list belongs in a tooltip and the detail panel. */
export function edgeLabel(names: string[]): string {
  const uniq = [...new Set(names)];
  return uniq.length <= 2 ? uniq.join(", ") : `${uniq.slice(0, 2).join(", ")} +${uniq.length - 2}`;
}

function fieldNames(fields: { name: string }[] | null): string {
  return (fields ?? []).map((f) => f.name).join(", ");
}

function healthOf(fn: TelelogFn): Health {
  return fn.status;
}

function fnNode(fn: TelelogFn, box: Box, drill?: Level): LNode {
  const role = fn.role ?? "sub";
  const route = fn.routes[0];
  const flow = [fieldNames(fn.inputs), fieldNames(fn.outputs)];
  const detail = flow[0] || flow[1] ? `${flow[0] || "–"} → ${flow[1] || "–"}` : undefined;
  const step = fn.n != null ? `, step ${fn.n}` : "";
  const status = fn.status === "ok" ? "" : `, ${fn.status}`;
  return {
    id: fn.id,
    kind: role,
    label: shortName(fn.id),
    sub: route ?? fn.purpose ?? undefined,
    detail,
    health: healthOf(fn),
    box,
    drill,
    fn: fn.id,
    aria: `${shortName(fn.id)}, ${role}${step}${status}`,
  };
}

function bounds(nodes: LNode[]): Box {
  if (!nodes.length) return { x: 0, y: 0, w: 400, h: 200 };
  const x2 = Math.max(...nodes.map((n) => n.box.x + n.box.w));
  const y2 = Math.max(...nodes.map((n) => n.box.y + n.box.h));
  return { x: 0, y: 0, w: x2, h: y2 };
}

function grid(count: number): { cols: number } {
  return { cols: Math.min(4, Math.max(1, Math.ceil(Math.sqrt(count)))) };
}

export function buildLevel(level: Level, data: TelelogMapData): LevelView {
  switch (level.kind) {
    case "project":
      return projectLevel(data);
    case "feature":
      return featureLevel(level.name, data);
    case "module":
      return moduleLevel(level.name, data);
    case "flow":
      return flowLevel(level.main, data);
    case "function":
      return functionLevel(level.id, data);
  }
}

function projectLevel(data: TelelogMapData): LevelView {
  const cards: Omit<LNode, "box">[] = [];
  const worst = (name: string): Health => {
    const own = Object.values(data.functions).filter((f) => (f.feature ?? "(no feature)") === name);
    return own.some((f) => f.status === "invalid") ? "invalid" : own.some((f) => f.status === "stale") ? "stale" : "ok";
  };
  for (const f of data.features) {
    const tables = f.tables.length ? ` · ${clip(f.tables.join(", "), 28)}` : "";
    cards.push({
      id: `feature:${f.name}`, kind: "feature", label: f.name, health: worst(f.name),
      sub: `${f.endpoints} endpoint${f.endpoints === 1 ? "" : "s"} · ${f.functions} functions${tables}`,
      drill: { kind: "feature", name: f.name },
      aria: `feature ${f.name}, ${f.endpoints} endpoints, ${f.functions} functions`,
    });
  }
  for (const [mod, ids] of Object.entries(data.untagged)) {
    cards.push({
      id: `module:${mod}`, kind: "untagged", label: mod, health: "untagged",
      sub: `${ids.length} untagged`, drill: { kind: "module", name: mod },
      aria: `module ${mod}, ${ids.length} untagged functions`,
    });
  }
  const { cols } = grid(cards.length);
  const nodes = cards.map((c, i) => ({
    ...c, box: { x: (i % cols) * (W + GAP), y: Math.floor(i / cols) * (H + GAP), w: W, h: H },
  }));
  return { nodes, edges: [], groups: [], bounds: bounds(nodes), empty: nodes.length ? undefined : "Nothing to show yet." };
}

function featureRoots(name: string, data: TelelogMapData): TelelogFn[] {
  const feat = data.features.find((f) => f.name === name);
  if (!feat) return [];
  const inFeature = Object.values(data.functions).filter((f) => (f.feature ?? "(no feature)") === name);
  const mains = inFeature.filter((f) => f.role === "main");
  const roots = mains.length ? mains : inFeature.filter((f) => !f.parent || data.functions[f.parent]?.feature !== f.feature);
  return roots.sort((a, b) => a.id.localeCompare(b.id));
}

function featureLevel(name: string, data: TelelogMapData): LevelView {
  const roots = featureRoots(name, data);
  const nodes = roots.map((fn, i) =>
    fnNode(fn, { x: 0, y: i * (H + GAP / 2), w: W * 2.4, h: H }, { kind: "flow", main: fn.id }));
  return { nodes, edges: [], groups: [], bounds: bounds(nodes), empty: nodes.length ? undefined : `No flows in ${name}.` };
}

function moduleLevel(name: string, data: TelelogMapData): LevelView {
  const ids = data.untagged[name] ?? [];
  const nodes: LNode[] = ids.map((id, i) => ({
    id, kind: "untagged", label: shortName(id), sub: "untagged: run /telelog in Claude Code", health: "untagged",
    box: { x: 0, y: i * (HELPER_H + 14), w: W * 1.6, h: HELPER_H + 4 }, fn: id, aria: `${shortName(id)}, untagged`,
  }));
  return { nodes, edges: [], groups: [], bounds: bounds(nodes), empty: nodes.length ? undefined : `No untagged functions in ${name}.` };
}

function stepsOf(main: string, data: TelelogMapData): TelelogFn[] {
  return (data.children[main] ?? []).map((id) => data.functions[id]).filter((f): f is TelelogFn => !!f && f.role !== "helper");
}

function flowLevel(mainId: string, data: TelelogMapData): LevelView {
  const main = data.functions[mainId];
  if (!main) return { nodes: [], edges: [], groups: [], bounds: bounds([]), empty: "That function is no longer tagged." };
  const steps = stepsOf(mainId, data);
  const ns = [...new Set(steps.map((s) => s.n ?? 10 ** 6 + steps.indexOf(s)))].sort((a, b) => a - b);
  const colOf = (s: TelelogFn) => ns.indexOf(s.n ?? 10 ** 6 + steps.indexOf(s)) + 1;
  const nodes: LNode[] = [fnNode(main, { x: 0, y: 0, w: W, h: H }, { kind: "function", id: mainId })];
  const groups: Box[] = [];
  const byCol = new Map<number, TelelogFn[]>();
  for (const s of steps) byCol.set(colOf(s), [...(byCol.get(colOf(s)) ?? []), s]);
  for (const [col, list] of [...byCol].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.id.localeCompare(b.id));
    list.forEach((s, row) =>
      nodes.push(fnNode(s, { x: col * (W + COL_GAP), y: row * (H + GAP), w: W, h: H }, { kind: "function", id: s.id })));
    if (list.length > 1) {
      groups.push({ x: col * (W + COL_GAP) - 10, y: -10, w: W + 20, h: list.length * (H + GAP) - GAP + 20 });
    }
  }
  const byShort = new Map(nodes.map((n) => [shortName(n.id), n]));
  const edges: LEdge[] = [];
  const colIndex = (n: LNode) => Math.round(n.box.x / (W + COL_GAP));
  for (const s of steps) {
    const me = nodes.find((n) => n.id === s.id)!;
    const linked = new Map<string, string[]>();
    for (const f of s.inputs ?? []) {
      for (const src of (f.source ?? "").split(",").map((x) => x.trim())) {
        const from = src.startsWith("step:") ? byShort.get(src.slice(5)) : undefined;
        if (from && from.id !== s.id) linked.set(from.id, [...(linked.get(from.id) ?? []), f.name]);
      }
    }
    if (linked.size === 0) {
      for (const n of nodes) if (colIndex(n) === colIndex(me) - 1) linked.set(n.id, []);
    }
    for (const [from, names] of linked) {
      edges.push({ from, to: me.id, label: names.length ? edgeLabel(names) : undefined, title: names.join(", ") || undefined });
    }
  }
  // database tables and external services under the flow, with the access mode / field names on the edge
  const side = new Map<string, { node: LNode; owners: Map<string, string[]> }>();
  const addSide = (key: string, kind: "table" | "external", label: string, owner: LNode, edgeText: string) => {
    let e = side.get(key);
    if (!e) {
      e = { node: { id: key, kind, label, health: "ok", box: { x: 0, y: 0, w: HELPER_W, h: HELPER_H }, aria: `${kind} ${label}` }, owners: new Map() };
      side.set(key, e);
    }
    e.owners.set(owner.id, [...(e.owners.get(owner.id) ?? []), edgeText]);
  };
  for (const n of nodes) {
    const fn = data.functions[n.id];
    for (const d of fn?.db ?? []) addSide(`table:${d.table}`, "table", d.table, n, d.mode);
    for (const f of fn?.inputs ?? []) {
      for (const src of (f.source ?? "").split(",").map((x) => x.trim())) {
        if (src.startsWith("external:")) addSide(`external:${src.slice(9)}`, "external", src.slice(9), n, f.name);
      }
    }
  }
  const flowBottom = Math.max(...nodes.map((n) => n.box.y + n.box.h));
  let i = 0;
  for (const e of side.values()) {
    e.node.box = { x: i * (HELPER_W + 20), y: flowBottom + COL_GAP / 2, w: HELPER_W, h: HELPER_H };
    nodes.push(e.node);
    for (const [owner, texts] of e.owners) edges.push({ from: owner, to: e.node.id, label: edgeLabel(texts), title: texts.join(", ") });
    i++;
  }
  return { nodes, edges, groups, bounds: bounds(nodes), empty: steps.length ? undefined : "No steps are tagged under this function yet." };
}

function functionLevel(id: string, data: TelelogMapData): LevelView {
  const fn = data.functions[id];
  if (!fn) return { nodes: [], edges: [], groups: [], bounds: bounds([]), empty: "That function is no longer tagged." };
  const nodes: LNode[] = [fnNode(fn, { x: 0, y: 0, w: W, h: H })];
  const helpers = (data.children[id] ?? []).map((c) => data.functions[c]).filter((f): f is TelelogFn => !!f);
  const edges: LEdge[] = [];
  helpers.forEach((h, i) => {
    const node = fnNode(h, { x: W + COL_GAP, y: i * (HELPER_H + 12), w: HELPER_W, h: HELPER_H }, h.role === "helper" ? undefined : { kind: "function", id: h.id });
    nodes.push(node);
    edges.push({ from: id, to: h.id });
  });
  return { nodes, edges, groups: [], bounds: bounds(nodes), empty: helpers.length ? undefined : "No helpers are tagged under this function." };
}

export interface Crumb {
  label: string;
  level: Level;
}

/** Where "up" goes from a level. */
export function parentLevel(level: Level, data: TelelogMapData): Level {
  switch (level.kind) {
    case "project":
      return level;
    case "feature":
    case "module":
      return { kind: "project" };
    case "flow":
      return { kind: "feature", name: data.functions[level.main]?.feature ?? "(no feature)" };
    case "function": {
      const fn = data.functions[level.id];
      if (!fn) return { kind: "project" };
      if (fn.role === "main" || !fn.parent) return { kind: "flow", main: level.id };
      const parent = data.functions[fn.parent];
      if (!parent) return { kind: "project" };
      return parent.role === "main" ? { kind: "flow", main: parent.id } : { kind: "function", id: parent.id };
    }
  }
}

export function crumbs(level: Level, data: TelelogMapData): Crumb[] {
  const out: Crumb[] = [{ label: "Project", level: { kind: "project" } }];
  const chain: Level[] = [];
  let cur: Level = level;
  while (cur.kind !== "project" && chain.length < 8) {
    chain.unshift(cur);
    const up = parentLevel(cur, data);
    if (sameLevel(up, cur)) break;
    cur = up;
  }
  for (const l of chain) {
    const label =
      l.kind === "feature" || l.kind === "module" ? l.name : l.kind === "flow" ? shortName(l.main) : l.kind === "function" ? shortName(l.id) : "Project";
    out.push({ label, level: l });
  }
  return out;
}

/** The level a function is shown on, for "jump to" from search. */
export function levelOf(id: string, data: TelelogMapData): Level {
  const fn = data.functions[id];
  if (fn) {
    if (fn.role === "main") return { kind: "flow", main: id };
    const parent = fn.parent ? data.functions[fn.parent] : undefined;
    if (!parent) return { kind: "feature", name: fn.feature ?? "(no feature)" };
    return parent.role === "main" ? { kind: "flow", main: parent.id } : { kind: "function", id: parent.id };
  }
  const mod = Object.keys(data.untagged).find((m) => data.untagged[m].includes(id));
  return mod ? { kind: "module", name: mod } : { kind: "project" };
}

export function matchesFilter(health: Health, filter: Health | "all"): boolean {
  return filter === "all" || health === filter;
}

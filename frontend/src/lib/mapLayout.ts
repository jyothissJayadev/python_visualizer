/* mapLayout.ts — deterministic left-to-right layout of the project map.
   Columns follow call depth from the entry point; modules are boxes stacked in a column,
   main functions are cards stacked inside their module box. Pure: same map -> same layout. */

import type { ProjectMap } from "./mapApi";

export const CARD_W = 230;
export const CARD_H = 74;
const CARD_GAP = 10;
const MOD_PAD = 14;
const MOD_HEAD = 34;
const MOD_GAP = 36;
const COL_GAP = 130;
export const MOD_W = CARD_W + MOD_PAD * 2;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MapLayout {
  entry: (Box & { id: string; label: string }) | null;
  modules: Record<string, Box & { col: number }>;
  cards: Record<string, Box>;
  moduleEdges: { from: string; to: string; count: number }[];
  bounds: Box;
}

export function layoutMap(map: ProjectMap): MapLayout {
  const fnModule = (id: string) => map.functions[id]?.module;

  // column of a module = shallowest call depth among its main functions
  const col: Record<string, number> = {};
  for (const m of map.modules) {
    const depths = m.functions.map((f) => map.functions[f]?.depth).filter((d): d is number => d != null);
    col[m.module] = depths.length ? Math.min(...depths) : 99;
  }
  const order = [...new Set(Object.values(col))].sort((a, b) => a - b);
  const colIndex = new Map(order.map((d, i) => [d, i]));

  const byCol = new Map<number, typeof map.modules>();
  for (const m of map.modules) {
    const c = colIndex.get(col[m.module]) ?? 0;
    byCol.set(c, [...(byCol.get(c) ?? []), m]);
  }

  const modules: MapLayout["modules"] = {};
  const cards: MapLayout["cards"] = {};
  const entryW = 190;
  const originX = map.entry_points.length ? entryW + COL_GAP : 0;

  for (const [c, mods] of [...byCol.entries()].sort((a, b) => a[0] - b[0])) {
    let y = 0;
    for (const m of mods.sort((a, b) => a.module.localeCompare(b.module))) {
      const h = MOD_HEAD + MOD_PAD + m.functions.length * (CARD_H + CARD_GAP) - CARD_GAP + MOD_PAD;
      const x = originX + c * (MOD_W + COL_GAP);
      modules[m.module] = { x, y, w: MOD_W, h, col: c };
      m.functions.forEach((f, i) => {
        cards[f] = { x: x + MOD_PAD, y: y + MOD_HEAD + MOD_PAD + i * (CARD_H + CARD_GAP), w: CARD_W, h: CARD_H };
      });
      y += h + MOD_GAP;
    }
  }

  const agg = new Map<string, number>();
  for (const e of map.edges) {
    const a = fnModule(e.from);
    const b = fnModule(e.to);
    if (a && b && a !== b) agg.set(`${a}\u0000${b}`, (agg.get(`${a}\u0000${b}`) ?? 0) + 1);
  }
  const moduleEdges = [...agg].map(([k, count]) => {
    const [from, to] = k.split("\u0000");
    return { from, to, count };
  });

  const boxes = Object.values(modules);
  const height = boxes.length ? Math.max(...boxes.map((b) => b.y + b.h)) : 200;
  const entry = map.entry_points.length
    ? {
        id: map.entry_points[0].id,
        label: map.entry_points[0].id,
        x: 0,
        y: Math.max(0, height / 2 - 45),
        w: entryW,
        h: 90,
      }
    : null;
  const right = boxes.length ? Math.max(...boxes.map((b) => b.x + b.w)) : entryW;
  return { entry, modules, cards, moduleEdges, bounds: { x: 0, y: 0, w: right, h: height } };
}

/** Cubic path from the right edge of `a` to the left edge of `b`. Same-column links leave and re-enter
 *  on the right side so they read as a short loop beside the cards instead of cutting through them. */
export function edgePath(a: Box, b: Box): string {
  const ax = a.x + a.w;
  const ay = a.y + a.h / 2;
  if (Math.abs(a.x - b.x) < 1) {
    const by = b.y + b.h / 2;
    const out = 46;
    return `M${ax},${ay} C${ax + out},${ay} ${ax + out},${by} ${ax},${by}`;
  }
  const bx = b.x;
  const by = b.y + b.h / 2;
  const dx = Math.max(Math.abs(bx - ax) / 2, 50);
  return `M${ax},${ay} C${ax + dx},${ay} ${bx - dx},${by} ${bx},${by}`;
}

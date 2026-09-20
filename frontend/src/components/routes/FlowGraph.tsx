import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { routesStore } from "../../lib/routesStore";
import { useRoutes } from "../../lib/useRoutes";
import { fmtMs, fnRuntime, hasKids, nodeSubtitle, nodeTitle, runtimeView } from "../../lib/routesUi";
import { OP_LABEL, tableLabel } from "../../lib/routesData";
import type { DataAccess, FnRuntime, TreeNode } from "../../lib/routesApi";

const W = 230;
const H = 48;
const XGAP = 74;
const YGAP = 12;
const MAX_NODES = 600;
const MIN_K = 0.2;
const MAX_K = 2;

const TABLE_H = 38;

interface L {
  node: TreeNode;
  /** unique key: the function's id, or `<function id>#t<n>` for a table attached to it */
  id: string;
  /** set when this is a database table node (a leaf attached to `node`) */
  table?: DataAccess;
  x: number;
  y: number;
  kids: L[];
}

interface Edge {
  key: string;
  d: string;
  cls: string;
  a: number; // index of the parent / child in layout.nodes (for culling)
  b: number;
}

/** World-pixel margin around the viewport: nodes are mounted slightly before
    they scroll into view, so panning never shows pop-in at the edges. */
const CULL_MARGIN = 260;

interface View {
  x: number;
  y: number;
  k: number;
}

interface NodeProps {
  node: TreeNode;
  x: number;
  y: number;
  selected: boolean;
  open: boolean;
  kids: boolean;
  rt: FnRuntime | undefined;
  dim: boolean;
  showTables: boolean;
}

/** One graph node. Memoised: panning/zooming never re-renders it, and a
    selection change re-renders only the two nodes whose `selected` flipped. */
const GraphNode = memo(function GraphNode({ node: n, x, y, selected, open, kids, rt, dim, showTables }: NodeProps) {
  const cls = "rt-gnode k-function" + (selected ? " selected" : "") + (n.cyclic ? " cyclic" : "") +
    (rt ? " obs" : "") + (dim ? " unobs" : "") + (rt && rt.errors > 0 ? " run-err" : "");
  return (
    <div
      className={cls}
      style={{ left: x, top: y, width: W, height: H }}
      onClick={() => routesStore.selectNode(n.id)}
      onDoubleClick={(e) => {
        e.preventDefault();
        kids && routesStore.toggle(n.id);
      }}
      onMouseDown={(e) => {
        if (e.button === 0) {
          e.preventDefault();
        }
      }}
      onDragStart={(e) => e.preventDefault()}
      title={n.function_id ?? nodeTitle(n)}
    >
      <span className="rt-glyph k-function">ƒ</span>
      <div className="rt-gtext">
        <div className="rt-gtitle">{nodeTitle(n)}</div>
        <div className="rt-gsub">
          {rt ? <span className="rt-grun">×{rt.calls} · {fmtMs(rt.avg_ms)}{rt.errors > 0 ? ` · ⚠ ${rt.errors}` : ""} · </span> : null}
          {!showTables && n.meta?.data?.length ? <span className="rt-gdb">▤ {n.meta.data.filter((d) => d.table !== "?").slice(0, 2).map((d) => tableLabel(d.table)).join(", ")}{n.meta.data.length > 2 ? "…" : ""} · </span> : null}
          {!open && (n.meta?.below_count ?? 0) > 0 ? <span className="rt-gdb" title="Tables reached by functions below">▤ {n.meta!.below_count} below · </span> : null}
          {nodeSubtitle(n)}
        </div>
      </div>
      {kids && (
        <button
          className="rt-gexpand"
          onClick={(e) => { e.stopPropagation(); routesStore.toggle(n.id); }}
          onMouseDown={(e) => e.stopPropagation()}
          title={open ? "Collapse" : "Expand"}
        >
          {open ? "−" : `+${n.children_count ?? n.children?.length ?? ""}`}
        </button>
      )}
    </div>
  );
});

/** A database table attached to the function that reads / writes it. */
const TableNode = memo(function TableNode({ d, x, y }: { d: DataAccess; x: number; y: number }) {
  const unknown = d.unattributed || d.table === "?";
  const cls = "rt-gtable " + (unknown ? "unknown" : "op-" + d.op) + (d.uncertain ? " uncertain" : "");
  const engine = d.table.startsWith("mongo:") ? "MongoDB" : "Neo4j";
  return (
    <div
      className={cls}
      style={{ left: x, top: y + (H - TABLE_H) / 2, width: W - 24, height: TABLE_H }}
      onClick={() => { if (!unknown) routesStore.openTable(d.table); }}
      onMouseDown={(e) => { if (e.button === 0) e.preventDefault(); }}
      onDragStart={(e) => e.preventDefault()}
      title={
        unknown
          ? `Database call not tied to a table${d.via ? ` (${d.via})` : ""}${d.reason ? ` — ${d.reason}` : ""}`
          : `${OP_LABEL[d.op]} ${d.table}${d.uncertain ? " — one of several possible labels" : ""} — click to open in the Data view`
      }
    >
      <span className="rt-gtable-icon">▤</span>
      <div className="rt-gtext">
        <div className="rt-gtitle">{unknown ? "unknown table" : tableLabel(d.table) + (d.uncertain ? "?" : "")}</div>
        <div className="rt-gsub">
          {unknown ? (d.via ? `${d.via}()` : "database call") : `${OP_LABEL[d.op]}${d.count > 1 ? ` ×${d.count}` : ""} · ${engine}`}
        </div>
      </div>
    </div>
  );
});

const EdgeLayer = memo(function EdgeLayer({ edges }: { edges: Edge[] }) {
  return (
    // 1x1 with overflow visible: paths are drawn in world coordinates, but the
    // element itself stays tiny instead of being a multi-megapixel surface
    <svg className="rt-graph-edges" width={1} height={1} style={{ overflow: "visible" }}>
      {edges.map((e) => <path key={e.key} d={e.d} className={e.cls} />)}
    </svg>
  );
});

/** Left-to-right node graph of what is currently expanded in the tree.

    Pan / zoom is applied straight to the canvas element's transform (one
    write per animation frame) instead of going through React state: a state
    update per mouse-move re-rendered every node and edge and froze the page. */
export function FlowGraph() {
  const s = useRoutes();
  const tree = s.tree;
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const view = useRef<View>({ x: 24, y: 24, k: 1 });
  const frame = useRef<number | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; id: number } | null>(null);
  const fittedFor = useRef<string | null>(null);
  const [visible, setVisible] = useState<number[]>([]);
  const visibleKey = useRef("");

  const rview = useMemo(() => runtimeView(s.runtime), [s.runtime]);
  const observedAny = (rview?.overlay.request_count ?? 0) > 0;

  const layout = useMemo(() => {
    if (!tree) return null;
    let count = 0;
    let cursor = 0;
    let truncated = false;
    const nodes: L[] = [];
    const rec = (n: TreeNode, depth: number): L => {
      count++;
      let kids: L[] = [];
      // the tables this function itself reads / writes: leaves right next to it
      // (created before its function children so the rows stay in order)
      if (s.showTables && n.meta?.data?.length && count + n.meta.data.length <= MAX_NODES) {
        kids = n.meta.data.map((d, i) => {
          count++;
          const leaf: L = { node: n, id: `${n.id}#t${i}`, table: d, x: (depth + 1) * (W + XGAP), y: (cursor++) * (H + YGAP), kids: [] };
          nodes.push(leaf);
          return leaf;
        });
      }
      if (s.expanded.has(n.id) && n.children) {
        if (count + n.children.length > MAX_NODES) truncated = truncated || n.children.length > 0;
        else kids = kids.concat(n.children.map((c) => rec(c, depth + 1)));
      }
      const x = depth * (W + XGAP);
      const y = kids.length ? (kids[0].y + kids[kids.length - 1].y) / 2 : (cursor++) * (H + YGAP);
      const l: L = { node: n, id: n.id, x, y, kids };
      nodes.push(l);
      return l;
    };
    rec(tree.root, 0);
    let maxX = 0;
    let maxY = 0;
    for (const n of nodes) {
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    const index = new Map<L, number>(nodes.map((n, i) => [n, i]));
    const edges: Edge[] = [];
    for (const p of nodes) {
      for (const c of p.kids) {
        const x1 = p.x + W;
        const y1 = p.y + H / 2;
        const mx = (x1 + c.x) / 2;
        const dc = c.table;
        edges.push({
          key: `${p.id}>${c.id}`,
          d: `M${x1},${y1} C${mx},${y1} ${mx},${c.y + H / 2} ${c.x},${c.y + H / 2}`,
          cls: dc
            ? "rt-edge edge-db " + (dc.unattributed || dc.table === "?" ? "unknown" : "op-" + dc.op) + (dc.uncertain ? " uncertain" : "")
            : "rt-edge edge-" + (c.node.edge ?? "call"),
          a: index.get(p) ?? 0,
          b: index.get(c) ?? 0,
        });
      }
    }
    return { nodes, edges, width: maxX + W, height: maxY + H, truncated };
  }, [tree, s.expanded, s.showTables]);

  /** Which nodes intersect the viewport (plus a margin). Only these are in
      the DOM, so a 600-node graph costs about as much as a 40-node one and
      the browser never has to hold a giant layer. React state changes only
      when the visible *set* changes, not on every pixel of movement. */
  const cullRef = useRef<() => void>(() => {});
  const cull = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp || !layout) return;
    const v = view.current;
    const x0 = -v.x / v.k - CULL_MARGIN;
    const y0 = -v.y / v.k - CULL_MARGIN;
    const x1 = (vp.clientWidth - v.x) / v.k + CULL_MARGIN;
    const y1 = (vp.clientHeight - v.y) / v.k + CULL_MARGIN;
    const out: number[] = [];
    layout.nodes.forEach((n, i) => {
      if (n.x + W >= x0 && n.x <= x1 && n.y + H >= y0 && n.y <= y1) out.push(i);
    });
    const key = out.join(",");
    if (key !== visibleKey.current) {
      visibleKey.current = key;
      setVisible(out);
    }
  }, [layout]);
  useLayoutEffect(() => {
    cullRef.current = cull;
  }, [cull]);

  /** Write the current view to the DOM — at most once per frame — and update
      which nodes are mounted. */
  const paint = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const el = canvasRef.current;
      const v = view.current;
      if (el) el.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
      cullRef.current();
    });
  }, []);

  const fit = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp || !layout) return;
    const k = Math.max(0.25, Math.min(1, (vp.clientWidth - 48) / layout.width, (vp.clientHeight - 48) / layout.height));
    view.current = { k, x: 24, y: Math.max(24, (vp.clientHeight - layout.height * k) / 2) };
    paint();
  }, [layout, paint]);

  const zoomAt = useCallback((px: number, py: number, factor: number) => {
    const v = view.current;
    const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor));
    const r = k / v.k;
    view.current = { k, x: px - (px - v.x) * r, y: py - (py - v.y) * r };
    paint();
  }, [paint]);

  // apply the stored view on mount, then fit once per endpoint
  useLayoutEffect(() => {
    visibleKey.current = ""; // a new layout invalidates the previous visible set
    paint();
  }, [paint, layout]);
  useEffect(() => {
    if (tree && layout && fittedFor.current !== tree.endpointId) {
      fittedFor.current = tree.endpointId;
      fit();
    }
  }, [tree, layout, fit]);

  // Cancel AND clear: under StrictMode (dev) this cleanup runs and the effect is
  // set up again — a stale id left in frame.current would make paint() return
  // early forever and nothing would ever be drawn.
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  // wheel zoom around the cursor (needs a non-passive listener to preventDefault)
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // Recalculate culled nodes when viewport resizes (e.g. when right sidebar is toggled)
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      cullRef.current();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // If the page ever stalls again, say so in the console (with how much was on screen)
  // — a freeze cannot report itself, but the long task that precedes it can.
  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return;
    let obs: PerformanceObserver | null = null;
    try {
      obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.duration >= 400) {
            console.warn(`[routes graph] main thread blocked for ${Math.round(e.duration)} ms`, {
              nodesMounted: canvasRef.current?.querySelectorAll(".rt-gnode").length,
              scale: view.current.k,
            });
          }
        }
      });
      obs.observe({ entryTypes: ["longtask"] });
    } catch {
      /* longtask not supported */
    }
    return () => obs?.disconnect();
  }, []);

  const endDrag = useCallback(() => {
    drag.current = null;
    viewportRef.current?.classList.remove("panning");
  }, []);

  // Safety net: if the release happens outside the window, or the window loses
  // focus mid-drag, the pointer events never arrive — end the drag ourselves so
  // the "grabbing" state and the drag can never get stuck.
  useEffect(() => {
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("blur", endDrag);
    return () => {
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("blur", endDrag);
    };
  }, [endDrag]);

  const visibleSet = useMemo(() => new Set(visible), [visible]);
  const shownNodes = useMemo(
    () => (layout ? visible.map((i) => layout.nodes[i]).filter(Boolean) : []),
    [layout, visible],
  );
  const shownEdges = useMemo(
    () => (layout ? layout.edges.filter((e) => visibleSet.has(e.a) || visibleSet.has(e.b)) : []),
    [layout, visibleSet],
  );

  if (!tree || !layout) return null;

  const centerZoom = (f: number) => {
    const vp = viewportRef.current;
    zoomAt(vp ? vp.clientWidth / 2 : 0, vp ? vp.clientHeight / 2 : 0, f);
  };

  return (
    <div className="rt-graph">
      <div
        className="rt-graph-viewport"
        ref={viewportRef}
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest(".rt-gnode, .rt-gtable, .rt-graph-toggle")) return;
          e.preventDefault();
          window.getSelection()?.removeAllRanges();
          drag.current = { x: e.clientX, y: e.clientY, vx: view.current.x, vy: view.current.y, id: e.pointerId };
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.classList.add("panning");
        }}
        onMouseDown={(e) => {
          if (e.button === 0) {
            e.preventDefault();
          }
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          view.current = { ...view.current, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y };
          paint();
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        <div className="rt-graph-canvas" ref={canvasRef}>
          <EdgeLayer edges={shownEdges} />
          {shownNodes.map(({ node: n, id, table, x, y }) => {
            if (table) return <TableNode key={id} d={table} x={x} y={y} />;
            const rt = fnRuntime(n, rview);
            return (
              <GraphNode
                key={id}
                node={n}
                x={x}
                y={y}
                showTables={s.showTables}
                selected={s.selectedNodeId === n.id}
                open={s.expanded.has(n.id)}
                kids={hasKids(n)}
                rt={rt}
                dim={observedAny && s.dimUnobserved && !rt}
              />
            );
          })}
        </div>
      </div>

      <label className="rt-graph-toggle" title="Draw the database tables each function reads or writes as nodes attached to it">
        <input type="checkbox" checked={s.showTables} onChange={(e) => routesStore.setShowTables(e.target.checked)} />
        Show database tables
      </label>
      <div className="rt-graph-controls">
        <button onClick={() => centerZoom(1.2)} title="Zoom in">+</button>
        <button onClick={() => centerZoom(1 / 1.2)} title="Zoom out">−</button>
        <button onClick={fit} title="Fit to view">Fit</button>
      </div>
      <div className="rt-graph-hint">
        Showing what is expanded in the tree · scroll to zoom · drag to pan · double-click a function to expand · click a table to open it
        {s.showTables && (
          <span className="rt-graph-legend">
            <i className="op-read" /> read <i className="op-write" /> write <i className="op-upsert" /> upsert <i className="op-delete" /> delete <i className="unknown" /> unknown
          </span>
        )}
      </div>
      {layout.truncated && (
        <div className="rt-graph-warn">Too many nodes to draw ({MAX_NODES}+) — some branches are left collapsed. Collapse parts of the tree, or use the tree view.</div>
      )}
    </div>
  );
}

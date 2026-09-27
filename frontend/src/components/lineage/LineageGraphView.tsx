import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { lineageStore, type NodeDetailModal } from "../../lib/lineageStore";
import { useLineage } from "../../lib/useLineage";
import {
  fileName,
  methodClass,
  type LineageTreeNode,
} from "../../lib/lineageTree";

const W = 260;
const H = 54;
const XGAP = 80;
const YGAP = 16;
const MAX_NODES = 800;
const MIN_K = 0.15;
const MAX_K = 2.5;
const CULL_MARGIN = 300;

interface LayoutNode {
  node: LineageTreeNode;
  id: string;
  x: number;
  y: number;
  kids: LayoutNode[];
}

interface Edge {
  key: string;
  d: string;
  kind: LineageTreeNode["kind"];
  a: number;
  b: number;
}

interface View {
  x: number;
  y: number;
  k: number;
}

function nodeToDetailModal(node: LineageTreeNode): NodeDetailModal {
  const typeMap: Record<LineageTreeNode["kind"], NodeDetailModal["type"]> = {
    brain: "brain_endpoint",
    service: "backend_service",
    controller: "backend_controller",
    route: "backend_route",
    client_api: "client_api",
    ui_component: "client_ui",
    unexposed: "note",
    note: "note",
  };

  return {
    type: typeMap[node.kind] || "note",
    title: node.label,
    subtitle: node.subLabel,
    file: node.filePath,
    line: node.line,
    snippet: node.snippet,
    data: node.raw,
  };
}

function getNodeGlyph(kind: LineageTreeNode["kind"]): { glyph: string; cls: string } {
  switch (kind) {
    case "brain":
      return { glyph: "🧠", cls: "k-function" };
    case "service":
      return { glyph: "⚙️", cls: "k-arm" };
    case "controller":
      return { glyph: "🎮", cls: "k-branch" };
    case "route":
      return { glyph: "🛣️", cls: "k-graph" };
    case "client_api":
      return { glyph: "🔌", cls: "k-dispatch" };
    case "ui_component":
      return { glyph: "🖥️", cls: "k-loop" };
    default:
      return { glyph: "ℹ️", cls: "k-external" };
  }
}

interface GraphNodeProps {
  node: LineageTreeNode;
  x: number;
  y: number;
  selected: boolean;
  open: boolean;
  hasKids: boolean;
  hit: boolean;
  current: boolean;
}

const LineageGraphNode = memo(function LineageGraphNode({
  node: n,
  x,
  y,
  selected,
  open,
  hasKids,
  hit,
  current,
}: GraphNodeProps) {
  const { glyph, cls: glyphCls } = getNodeGlyph(n.kind);

  const cls = [
    "rt-gnode",
    "lineage-gnode",
    glyphCls,
    `lineage-kind-${n.kind}`,
    selected ? "selected" : "",
    hit ? "hit" : "",
    current ? "hit-current" : "",
  ].join(" ");

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const detail = nodeToDetailModal(n);
    lineageStore.selectTreeNode(n.id, detail);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (hasKids) {
      lineageStore.toggleTreeNode(n.id);
    }
  };

  return (
    <div
      className={cls}
      style={{ left: x, top: y, width: W, height: H }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onMouseDown={(e) => {
        if (e.button === 0) e.preventDefault();
      }}
      onDragStart={(e) => e.preventDefault()}
      title={`${n.label}${n.filePath ? ` (${n.filePath}:${n.line})` : ""}`}
    >
      <span className={`rt-glyph ${glyphCls}`}>{glyph}</span>

      <div className="rt-gtext">
        <div className="rt-gtitle">
          {n.method && (
            <span className={`rt-method ${methodClass(n.method)}`} style={{ marginRight: 6 }}>
              {n.method}
            </span>
          )}
          {n.name}
        </div>

        <div className="rt-gsub">
          {n.app && (
            <span className={`app-badge app-${n.app}`} style={{ marginRight: 6 }}>
              {n.app}
            </span>
          )}
          {n.filePath ? `${fileName(n.filePath)}${n.line ? `:${n.line}` : ""}` : n.subLabel || ""}
        </div>
      </div>

      {hasKids && (
        <button
          className="rt-gexpand"
          onClick={(e) => {
            e.stopPropagation();
            lineageStore.toggleTreeNode(n.id);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          title={open ? "Collapse branch" : `Expand ${n.children.length} items`}
        >
          {open ? "−" : `+${n.children.length}`}
        </button>
      )}
    </div>
  );
});

const EdgeLayer = memo(function EdgeLayer({ edges }: { edges: Edge[] }) {
  return (
    <svg className="rt-graph-edges" width={1} height={1} style={{ overflow: "visible" }}>
      {edges.map((e) => (
        <path key={e.key} d={e.d} className={`rt-edge edge-${e.kind}`} />
      ))}
    </svg>
  );
});

export function LineageGraphView() {
  const {
    tree,
    expandedTreeNodes,
    selectedTreeNodeId,
    searchHits,
    searchIndex,
  } = useLineage();

  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const view = useRef<View>({ x: 40, y: 40, k: 1 });
  const frame = useRef<number | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; id: number } | null>(null);
  const fittedFor = useRef<string | null>(null);
  const [visible, setVisible] = useState<number[]>([]);
  const visibleKey = useRef("");

  const hitSet = useMemo(() => new Set(searchHits), [searchHits]);
  const currentHit = searchHits[searchIndex];

  // ── Layout Computation ──────────────────────────────────────────────────
  const layout = useMemo(() => {
    if (!tree) return null;
    let count = 0;
    let cursor = 0;
    let truncated = false;
    const nodes: LayoutNode[] = [];

    const rec = (n: LineageTreeNode, depth: number): LayoutNode => {
      count++;
      let kids: LayoutNode[] = [];

      if (expandedTreeNodes.has(n.id) && n.children && n.children.length > 0) {
        if (count + n.children.length > MAX_NODES) {
          truncated = true;
        } else {
          kids = n.children.map((c) => rec(c, depth + 1));
        }
      }

      const x = depth * (W + XGAP);
      const y =
        kids.length > 0
          ? (kids[0].y + kids[kids.length - 1].y) / 2
          : (cursor++) * (H + YGAP);

      const lNode: LayoutNode = { node: n, id: n.id, x, y, kids };
      nodes.push(lNode);
      return lNode;
    };

    rec(tree, 0);

    let maxX = 0;
    let maxY = 0;
    for (const n of nodes) {
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }

    const index = new Map<LayoutNode, number>(nodes.map((n, i) => [n, i]));
    const edges: Edge[] = [];

    for (const p of nodes) {
      for (const c of p.kids) {
        const x1 = p.x + W;
        const y1 = p.y + H / 2;
        const x2 = c.x;
        const y2 = c.y + H / 2;
        const mx = (x1 + x2) / 2;

        edges.push({
          key: `${p.id}>${c.id}`,
          d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
          kind: c.node.kind,
          a: index.get(p) ?? 0,
          b: index.get(c) ?? 0,
        });
      }
    }

    return {
      nodes,
      edges,
      width: maxX + W + 60,
      height: maxY + H + 60,
      truncated,
    };
  }, [tree, expandedTreeNodes]);

  // ── Viewport Culling ────────────────────────────────────────────────────
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
      if (n.x + W >= x0 && n.x <= x1 && n.y + H >= y0 && n.y <= y1) {
        out.push(i);
      }
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

  // ── Paint Canvas Transform ──────────────────────────────────────────────
  const paint = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const el = canvasRef.current;
      const v = view.current;
      if (el) {
        el.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
      }
      cullRef.current();
    });
  }, []);

  const fit = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp || !layout) return;
    const k = Math.max(
      0.2,
      Math.min(
        1,
        (vp.clientWidth - 80) / layout.width,
        (vp.clientHeight - 80) / layout.height,
      ),
    );
    view.current = {
      k,
      x: 40,
      y: Math.max(40, (vp.clientHeight - layout.height * k) / 2),
    };
    paint();
  }, [layout, paint]);

  const zoomAt = useCallback(
    (px: number, py: number, factor: number) => {
      const v = view.current;
      const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor));
      const r = k / v.k;
      view.current = {
        k,
        x: px - (px - v.x) * r,
        y: py - (py - v.y) * r,
      };
      paint();
    },
    [paint],
  );

  // Apply layout on mount and auto-fit when tree changes
  useLayoutEffect(() => {
    visibleKey.current = "";
    paint();
  }, [paint, layout]);

  useEffect(() => {
    if (tree && layout && fittedFor.current !== tree.id) {
      fittedFor.current = tree.id;
      fit();
    }
  }, [tree, layout, fit]);

  // Clean animation frame
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  // Wheel zoom around cursor
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(
        e.clientX - rect.left,
        e.clientY - rect.top,
        e.deltaY < 0 ? 1.12 : 1 / 1.12,
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // ResizeObserver for viewport
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      cullRef.current();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const endDrag = useCallback(() => {
    drag.current = null;
    viewportRef.current?.classList.remove("panning");
  }, []);

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
    () =>
      layout
        ? layout.edges.filter(
            (e) => visibleSet.has(e.a) || visibleSet.has(e.b),
          )
        : [],
    [layout, visibleSet],
  );

  if (!tree || !layout) return null;

  const centerZoom = (f: number) => {
    const vp = viewportRef.current;
    zoomAt(vp ? vp.clientWidth / 2 : 0, vp ? vp.clientHeight / 2 : 0, f);
  };

  return (
    <div className="rt-graph lineage-graph">
      <div
        className="rt-graph-viewport"
        ref={viewportRef}
        onPointerDown={(e) => {
          if (
            e.button !== 0 ||
            (e.target as HTMLElement).closest(".rt-gnode, .rt-graph-controls")
          ) {
            return;
          }
          e.preventDefault();
          window.getSelection()?.removeAllRanges();
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            vx: view.current.x,
            vy: view.current.y,
            id: e.pointerId,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.classList.add("panning");
        }}
        onMouseDown={(e) => {
          if (e.button === 0) e.preventDefault();
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          view.current = {
            ...view.current,
            x: d.vx + e.clientX - d.x,
            y: d.vy + e.clientY - d.y,
          };
          paint();
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        <div className="rt-graph-canvas" ref={canvasRef}>
          <EdgeLayer edges={shownEdges} />

          {shownNodes.map(({ node: n, id, x, y }) => (
            <LineageGraphNode
              key={id}
              node={n}
              x={x}
              y={y}
              selected={selectedTreeNodeId === n.id}
              open={expandedTreeNodes.has(n.id)}
              hasKids={Boolean(n.children && n.children.length > 0)}
              hit={hitSet.has(n.id)}
              current={currentHit === n.id}
            />
          ))}
        </div>
      </div>

      {/* Floating Controls */}
      <div className="rt-graph-controls">
        <button onClick={() => centerZoom(1.2)} title="Zoom in">
          +
        </button>
        <button onClick={() => centerZoom(1 / 1.2)} title="Zoom out">
          −
        </button>
        <button onClick={fit} title="Fit graph to view">
          Fit
        </button>
      </div>

      {/* Bottom Status Hint */}
      <div className="rt-graph-hint">
        Scroll to zoom · Drag canvas to pan · Double-click node to expand/collapse · Click node to inspect details
      </div>

      {layout.truncated && (
        <div className="rt-graph-warn">
          Large lineage graph ({MAX_NODES}+ nodes) — some deeper branches are collapsed.
        </div>
      )}
    </div>
  );
}

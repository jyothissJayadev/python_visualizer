import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { lineageStore, type NodeDetailModal } from "../../lib/lineageStore";
import { useLineage } from "../../lib/useLineage";
import {
  fileName,
  flattenLineageTree,
  methodClass,
  type FlattenedLineageRow,
  type LineageTreeNode,
} from "../../lib/lineageTree";

const ROW_H = 30;
const OVERSCAN = 12;
const INDENT = 20;

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

interface RowProps {
  row: FlattenedLineageRow;
  selected: boolean;
  open: boolean;
  hit: boolean;
  current: boolean;
  top: number;
}

const LineageTreeRow = memo(function LineageTreeRow({
  row,
  selected,
  open,
  hit,
  current,
  top,
}: RowProps) {
  const n = row.node;
  const { glyph, cls: glyphCls } = getNodeGlyph(n.kind);

  const rowCls = [
    "rt-row",
    glyphCls,
    `lineage-kind-${n.kind}`,
    selected ? "selected" : "",
    hit ? "hit" : "",
    current ? "hit-current" : "",
  ].join(" ");

  const handleClick = () => {
    const detail = nodeToDetailModal(n);
    lineageStore.selectTreeNode(n.id, detail);
  };

  const handleDoubleClick = () => {
    if (row.hasChildren) {
      lineageStore.toggleTreeNode(n.id);
    }
  };

  return (
    <div
      className={rowCls}
      style={{
        top,
        height: ROW_H,
        paddingLeft: 8 + row.depth * INDENT,
        ["--depth" as string]: row.depth,
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      title={`${n.label}${n.filePath ? ` (${n.filePath})` : ""}`}
    >
      {/* Expand / Collapse Chevron */}
      <button
        className={"rt-chevron" + (open ? " open" : "") + (row.hasChildren ? "" : " none")}
        onClick={(e) => {
          e.stopPropagation();
          lineageStore.toggleTreeNode(n.id);
        }}
        tabIndex={-1}
        aria-label={open ? "Collapse" : "Expand"}
      >
        ▸
      </button>

      {/* Layer Kind Glyph */}
      <span className={`rt-glyph ${glyphCls}`}>{glyph}</span>

      {/* Method tag if applicable */}
      {n.method && (
        <span className={`rt-method ${methodClass(n.method)}`}>
          {n.method}
        </span>
      )}

      {/* Node Name */}
      <span className="rt-name">{n.name}</span>

      {/* App Badge */}
      {n.app && (
        <span className={`app-badge app-${n.app}`}>
          {n.app}
        </span>
      )}

      {/* Sublabel / Calling context */}
      {n.subLabel && <span className="rt-doc">{n.subLabel}</span>}

      {/* Collapsed Children Counter */}
      {!open && row.hasChildren && n.children.length > 0 && (
        <span className="rt-more" title={`${n.children.length} items below`}>
          +{n.children.length}
        </span>
      )}

      <span className="rt-spacer" />

      {/* Source Location */}
      {n.filePath && (
        <span className="rt-loc">
          {fileName(n.filePath)}
          {n.line ? `:${n.line}` : ""}
        </span>
      )}
    </div>
  );
});

export function LineageHierarchyTree() {
  const {
    tree,
    expandedTreeNodes,
    selectedTreeNodeId,
    searchHits,
    searchIndex,
  } = useLineage();

  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const raf = useRef<number | null>(null);

  const rows = useMemo<FlattenedLineageRow[]>(() => {
    if (!tree) return [];
    return flattenLineageTree(tree, expandedTreeNodes);
  }, [tree, expandedTreeNodes]);

  const hitSet = useMemo(() => new Set(searchHits), [searchHits]);
  const currentHit = searchHits[searchIndex];

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
  }, []);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (raf.current !== null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      setScrollTop(el.scrollTop);
    });
  };

  const reveal = (index: number) => {
    const el = ref.current;
    if (!el || index < 0) return;
    const top = index * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + ROW_H - el.clientHeight;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!rows.length) return;
    const idx = Math.max(
      0,
      rows.findIndex((r) => r.node.id === selectedTreeNodeId),
    );
    const row = rows[idx];

    const go = (i: number) => {
      const j = Math.min(rows.length - 1, Math.max(0, i));
      const targetNode = rows[j].node;
      lineageStore.selectTreeNode(targetNode.id, nodeToDetailModal(targetNode));
      reveal(j);
    };

    switch (e.key) {
      case "ArrowDown":
        go(idx + 1);
        break;
      case "ArrowUp":
        go(idx - 1);
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(rows.length - 1);
        break;
      case "ArrowRight":
        if (row.hasChildren && !expandedTreeNodes.has(row.node.id)) {
          lineageStore.expandTreeNode(row.node.id);
        } else if (rows[idx + 1]?.parentIndex === idx) {
          go(idx + 1);
        }
        break;
      case "ArrowLeft":
        if (expandedTreeNodes.has(row.node.id) && row.hasChildren) {
          lineageStore.collapseTreeNode(row.node.id);
        } else if (row.parentIndex >= 0) {
          go(row.parentIndex);
        }
        break;
      case "Enter":
      case " ":
        if (row.hasChildren) {
          lineageStore.toggleTreeNode(row.node.id);
        }
        lineageStore.selectTreeNode(row.node.id, nodeToDetailModal(row.node));
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  if (!tree) {
    return (
      <div className="rt-state">
        Select an endpoint to view its cross-layer call hierarchy.
      </div>
    );
  }

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);

  return (
    <div className="lineage-tree-wrapper">
      <div
        className="rt-tree lineage-tree"
        ref={ref}
        tabIndex={0}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
      >
        <div style={{ height: rows.length * ROW_H, position: "relative" }}>
          {rows.slice(start, end).map((row, k) => {
            const n = row.node;
            return (
              <LineageTreeRow
                key={n.id}
                row={row}
                selected={selectedTreeNodeId === n.id}
                open={expandedTreeNodes.has(n.id)}
                hit={hitSet.has(n.id)}
                current={currentHit === n.id}
                top={(start + k) * ROW_H}
              />
            );
          })}
        </div>
      </div>

      {/* Tree View Legend */}
      <div className="rt-legend">
        <span>
          <i className="rt-glyph k-function">🧠</i> Brain Endpoint
        </span>
        <span>
          <i className="rt-glyph k-arm">⚙️</i> Backend Service
        </span>
        <span>
          <i className="rt-glyph k-branch">🎮</i> Controller
        </span>
        <span>
          <i className="rt-glyph k-graph">🛣️</i> Express Route
        </span>
        <span>
          <i className="rt-glyph k-dispatch">🔌</i> Client API
        </span>
        <span>
          <i className="rt-glyph k-loop">🖥️</i> React UI
        </span>
        <span className="rt-legend-keys">
          ↑↓ move · ←→ collapse/expand · ⏎ inspect
        </span>
      </div>
    </div>
  );
}

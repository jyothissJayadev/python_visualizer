import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { routesStore } from "../../lib/routesStore";
import { useRoutes } from "../../lib/useRoutes";
import {
  EDGE_LABEL, edgeConfirmed, fileName, flatten, fmtMs, fnRuntime, runtimeView, type Row, type RuntimeView,
} from "../../lib/routesUi";
import { OP_LABEL, tableLabel } from "../../lib/routesData";
import type { DataAccess, FnRuntime, TreeNode } from "../../lib/routesApi";

const ROW_H = 28;
const OVERSCAN = 10;
const INDENT = 18;

interface RowProps {
  node: TreeNode;
  depth: number;
  hasChildren: boolean;
  selected: boolean;
  open: boolean;
  loading: boolean;
  hit: boolean;
  current: boolean;
  top: number;
  rt: FnRuntime | undefined;
  armed: boolean | undefined; // undefined = not armed, false = shallow, true = deep
  confirmed: boolean;
  dim: boolean;
}

/** A table chip: solid = certain, dotted "?" = one of several possible labels,
    amber "unknown" = a database call that could not be tied to a table. */
function DataChip({ d }: { d: DataAccess }) {
  if (d.unattributed || d.table === "?") {
    return (
      <span className="rt-db unknown" title={`Database call not tied to a table${d.via ? ` (${d.via})` : ""}${d.reason ? ` — ${d.reason}` : ""}`}>
        unknown table
      </span>
    );
  }
  return (
    <button
      className={"rt-db op-" + d.op + (d.uncertain ? " uncertain" : "")}
      title={`${OP_LABEL[d.op]} ${d.table}${d.count > 1 ? ` ×${d.count}` : ""}${d.uncertain ? " — one of several possible labels (chosen at runtime)" : ""} — click to see it in the Data view`}
      onClick={(e) => { e.stopPropagation(); routesStore.openTable(d.table); }}
    >
      {tableLabel(d.table)}{d.uncertain ? "?" : ""}
    </button>
  );
}

/** One tree row. Memoised on primitives + node identity, so expanding or
    selecting re-renders only the rows whose own state changed. */
const TreeRow = memo(function TreeRow(p: RowProps) {
  const n = p.node;
  const showEdge = n.edge && !["call", "handler", "await"].includes(n.edge);
  const cls = [
    "rt-row k-function",
    p.selected ? "selected" : "",
    p.hit ? "hit" : "",
    p.current ? "hit-current" : "",
    p.rt ? "obs" : "",
    p.dim ? "unobs" : "",
    p.rt && p.rt.errors > 0 ? "run-err" : "",
    n.cyclic ? "cyclic" : "",
  ].join(" ");
  const libs = n.meta?.library_count ?? 0;
  return (
    <div
      className={cls}
      style={{ top: p.top, height: ROW_H, paddingLeft: 8 + p.depth * INDENT, ["--depth" as string]: p.depth }}
      onClick={() => routesStore.selectNode(n.id)}
      onDoubleClick={() => p.hasChildren && routesStore.toggle(n.id)}
      title={n.function_id}
    >
      <button
        className={"rt-chevron" + (p.open ? " open" : "") + (p.hasChildren ? "" : " none")}
        onClick={(e) => { e.stopPropagation(); routesStore.toggle(n.id); }}
        tabIndex={-1}
        aria-label={p.open ? "Collapse" : "Expand"}
      >
        {p.loading ? <span className="rt-spinner" /> : "▸"}
      </button>
      <span className="rt-glyph k-function">ƒ</span>
      <span className="rt-name">{n.name}</span>
      {n.is_async && <span className="rt-tag async">async</span>}
      {showEdge && <span className={"rt-tag edge-" + n.edge}>{EDGE_LABEL[n.edge!] ?? n.edge}</span>}
      {n.meta?.stub && <span className="rt-tag stub">abstract</span>}
      {n.cyclic && <span className="rt-tag cyc" title="Recursive call — not expanded again">↺ recursive</span>}
      {n.meta?.count && n.meta.count > 1 && <span className="rt-count" title={`Called from ${n.meta.count} places in the parent`}>×{n.meta.count}</span>}
      {p.rt && (
        <span className="rt-run" title={`${p.rt.calls} call(s) in ${p.rt.requests} request(s) · avg ${fmtMs(p.rt.avg_ms)} · max ${fmtMs(p.rt.max_ms)}`}>
          {p.confirmed && <b className="rt-confirm" title="This call edge was seen at runtime">✓</b>}
          ×{p.rt.calls} · {fmtMs(p.rt.avg_ms)}
        </span>
      )}
      {p.rt && p.rt.errors > 0 && <span className="rt-tag err" title="Raised an exception at runtime">⚠ {p.rt.errors}</span>}
      {p.armed !== undefined && (
        <span className={"rt-armed" + (p.armed ? " deep" : "")} title={p.armed ? "Armed (deep) — recording this call and everything under it" : "Armed (shallow)"} />
      )}
      {n.meta?.data && n.meta.data.length > 0 && (
        <span className="rt-dbchips">
          {n.meta.data.slice(0, 3).map((d) => <DataChip key={d.table + d.op + (d.unattributed ? "u" : "")} d={d} />)}
          {n.meta.data.length > 3 && (
            <span className="rt-db more" title={n.meta.data.slice(3).map((d) => `${OP_LABEL[d.op]} ${d.table}`).join("\n")}>
              +{n.meta.data.length - 3}
            </span>
          )}
        </span>
      )}
      {!p.open && (n.meta?.below_count ?? 0) > 0 && (
        <span className="rt-below" title={`${n.meta!.below_count} table(s) are reached by functions below this one — select it to list them`}>
          ▤ {n.meta!.below_count} below
        </span>
      )}
      {n.doc && <span className="rt-doc">{n.doc}</span>}
      <span className="rt-spacer" />
      {libs > 0 && <span className="rt-lib" title="Calls to library / built-in / unresolved functions — select to list them">{libs} lib</span>}
      {!p.open && (n.children_count ?? n.children?.length) ? <span className="rt-more">+{n.children_count ?? n.children?.length}</span> : null}
      {n.file_path && <span className="rt-loc">{fileName(n.file_path)}:{n.line}</span>}
    </div>
  );
});

/** The collapsible, lazily-loaded call hierarchy of user-defined functions.
    Rows are fixed-height and windowed, so a deep tree scrolls smoothly. */
export function HierarchyTree() {
  const s = useRoutes();
  const tree = s.tree;
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const raf = useRef<number | null>(null);

  const rows = useMemo<Row[]>(() => (tree ? flatten(tree.root, s.expanded) : []), [tree, s.expanded]);
  const view = useMemo<RuntimeView | null>(() => runtimeView(s.runtime), [s.runtime]);
  const observedAny = (view?.overlay.request_count ?? 0) > 0;
  const hitSet = useMemo(() => new Set(s.searchHits), [s.searchHits]);
  const currentHit = s.searchHits[s.searchIndex];

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // cancel AND clear (StrictMode re-runs effects; a stale id would block onScroll forever)
  useEffect(() => () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
  }, []);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (raf.current !== null) return; // one state update per frame, however many scroll events fire
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
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  };

  // scroll a search hit / requested node into the middle of the view
  useEffect(() => {
    if (!s.scrollTo) return;
    const index = rows.findIndex((r) => r.node.id === s.scrollTo!.id);
    const el = ref.current;
    if (index >= 0 && el) el.scrollTop = Math.max(0, index * ROW_H - el.clientHeight / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.scrollTo]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!rows.length) return;
    const idx = Math.max(0, rows.findIndex((r) => r.node.id === s.selectedNodeId));
    const row = rows[idx];
    const go = (i: number) => {
      const j = Math.min(rows.length - 1, Math.max(0, i));
      routesStore.selectNode(rows[j].node.id);
      reveal(j);
    };
    switch (e.key) {
      case "ArrowDown": go(idx + 1); break;
      case "ArrowUp": go(idx - 1); break;
      case "Home": go(0); break;
      case "End": go(rows.length - 1); break;
      case "ArrowRight":
        if (row.hasChildren && !s.expanded.has(row.node.id)) routesStore.expand(row.node.id);
        else if (rows[idx + 1]?.parentIndex === idx) go(idx + 1);
        break;
      case "ArrowLeft":
        if (s.expanded.has(row.node.id) && row.hasChildren) routesStore.collapse(row.node.id);
        else if (row.parentIndex >= 0) go(row.parentIndex);
        break;
      case "Enter":
      case " ":
        if (row.hasChildren) routesStore.toggle(row.node.id);
        break;
      default: return;
    }
    e.preventDefault();
  };

  if (!tree) return null;

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);

  return (
    <div className="rt-tree" ref={ref} tabIndex={0} onScroll={onScroll} onKeyDown={onKeyDown}>
      <div style={{ height: rows.length * ROW_H, position: "relative" }}>
        {rows.slice(start, end).map((row, k) => {
          const n = row.node;
          const rt = fnRuntime(n, view);
          return (
            <TreeRow
              key={n.id}
              node={n}
              depth={row.depth}
              hasChildren={row.hasChildren}
              selected={s.selectedNodeId === n.id}
              open={s.expanded.has(n.id)}
              loading={s.loadingNodes.has(n.id)}
              hit={hitSet.has(n.id)}
              current={currentHit === n.id}
              top={(start + k) * ROW_H}
              rt={rt}
              armed={n.function_id ? view?.overlay.armed[n.function_id] : undefined}
              confirmed={edgeConfirmed(row.fnParent, n, view)}
              dim={observedAny && s.dimUnobserved && !rt}
            />
          );
        })}
      </div>
    </div>
  );
}

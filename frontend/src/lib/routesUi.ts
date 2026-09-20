/* routesUi.ts — presentation helpers shared by the routes components:
   node-kind metadata, method colours, and the tree flattening / filtering
   used by both the tree view and the flow graph. */

import type { FnRuntime, NodeKind, RuntimeOverlay, TreeNode } from "./routesApi";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "WS"] as const;

export function methodClass(method: string): string {
  const m = method.toLowerCase();
  return ["get", "post", "put", "patch", "delete", "ws"].includes(m) ? `m-${m}` : "m-other";
}

export interface KindMeta {
  label: string;
  glyph: string;
  cls: string;
}

export const KIND_META: Record<NodeKind, KindMeta> = {
  function: { label: "function", glyph: "ƒ", cls: "k-function" },
  external: { label: "external", glyph: "⊕", cls: "k-external" },
  unresolved: { label: "unresolved", glyph: "?", cls: "k-unresolved" },
  class: { label: "class()", glyph: "C", cls: "k-class" },
  loop: { label: "loop", glyph: "↻", cls: "k-loop" },
  branch: { label: "branch", glyph: "⑂", cls: "k-branch" },
  arm: { label: "branch arm", glyph: "›", cls: "k-arm" },
  graph: { label: "LangGraph", glyph: "◈", cls: "k-graph" },
  dispatch: { label: "dispatch", glyph: "⇉", cls: "k-dispatch" },
};

export const EDGE_LABEL: Record<string, string> = {
  call: "call",
  await: "await",
  spawn: "spawn",
  callback: "callback",
  depends: "Depends",
  graph_node: "graph node",
  router: "router",
  instantiate: "new",
  handler: "handler",
};

export interface Row {
  node: TreeNode;
  depth: number;
  parentIndex: number; // index into rows, -1 for the root
  hasChildren: boolean;
  fnParent: string | null; // function id of the nearest enclosing function node
}

export function hasKids(n: TreeNode): boolean {
  return (n.children?.length ?? 0) > 0 || (n.children_count ?? 0) > 0;
}

/** Depth-first flatten of what the tree view shows. */
export function flatten(root: TreeNode, expanded: Set<string>): Row[] {
  const rows: Row[] = [];
  const walk = (n: TreeNode, depth: number, parentIndex: number, fnParent: string | null) => {
    const index = rows.length;
    rows.push({ node: n, depth, parentIndex, hasChildren: hasKids(n), fnParent });
    if (!expanded.has(n.id) || !n.children) return;
    const next = n.kind === "function" && n.function_id ? n.function_id : fnParent;
    for (const c of n.children) walk(c, depth + 1, index, next);
  };
  walk(root, 0, -1, null);
  return rows;
}

export function findNode(root: TreeNode | null, id: string): TreeNode | null {
  if (!root) return null;
  let cur = root;
  const parts = id.split(".");
  for (let i = 1; i < parts.length; i++) {
    const next = cur.children?.[Number(parts[i])];
    if (!next) return null;
    cur = next;
  }
  return cur;
}

/** Immutable replace of the node at `id` (path ids index into children). */
export function replaceAt(root: TreeNode, id: string, node: TreeNode): TreeNode {
  const parts = id.split(".").slice(1).map(Number);
  const rec = (cur: TreeNode, i: number): TreeNode => {
    if (i === parts.length) return node;
    const kids = cur.children ? [...cur.children] : [];
    kids[parts[i]] = rec(kids[parts[i]], i + 1);
    return { ...cur, children: kids };
  };
  return rec(root, 0);
}

export function matches(n: TreeNode, needle: string): boolean {
  const hay = `${n.name} ${n.function_id ?? ""} ${n.label ?? ""} ${n.call_expr ?? ""} ${n.external ?? ""}`;
  return hay.toLowerCase().includes(needle);
}

/** ids of nodes matching `needle`, plus the ids of all their ancestors. */
export function searchTree(root: TreeNode, needle: string): { hits: string[]; ancestors: Set<string> } {
  const hits: string[] = [];
  const ancestors = new Set<string>();
  const walk = (n: TreeNode, trail: string[]) => {
    if (n.id !== root.id && matches(n, needle)) {
      hits.push(n.id);
      trail.forEach((a) => ancestors.add(a));
    }
    for (const c of n.children ?? []) walk(c, [...trail, n.id]);
  };
  walk(root, []);
  return { hits, ancestors };
}

/** ids of every loaded node above `depth` levels that has children. */
export function idsWithinDepth(root: TreeNode, levels: number): Set<string> {
  const out = new Set<string>();
  const walk = (n: TreeNode, depth: number) => {
    if (depth >= levels || !n.children) return;
    out.add(n.id);
    n.children.forEach((c) => walk(c, depth + 1));
  };
  walk(root, 0);
  return out;
}

/** Initially only the endpoint handler is open, so its direct callees show. */
export function autoExpand(root: TreeNode): Set<string> {
  return new Set([root.id]);
}

export function fileName(path: string | undefined): string {
  return path ? path.split("/").slice(-2).join("/") : "";
}

/** Splits "/a/{id}/b" into parts so path params can be styled. */
export function pathParts(path: string): { text: string; param: boolean }[] {
  return path
    .split(/(\{[^}]+\})/g)
    .filter(Boolean)
    .map((text) => ({ text, param: text.startsWith("{") }));
}

export function timeAgo(epochSeconds: number | null): string {
  if (!epochSeconds) return "never";
  const s = Math.max(0, Math.round(Date.now() / 1000 - epochSeconds));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/** The one-line label a node shows in the tree and the graph. */
export function nodeTitle(n: TreeNode): string {
  return n.name;
}

/** Secondary text: how it is reached, or where it lives. */
export function nodeSubtitle(n: TreeNode): string {
  const parts: string[] = [];
  if (n.edge && !["call", "await", "handler"].includes(n.edge)) parts.push(EDGE_LABEL[n.edge] ?? n.edge);
  if (n.file_path) parts.push(`${fileName(n.file_path)}:${n.line}`);
  return parts.join(" · ");
}

/* ---- runtime overlay ---- */

export interface RuntimeView {
  overlay: RuntimeOverlay;
  confirmed: Set<string>;
}

export function runtimeView(overlay: RuntimeOverlay | null): RuntimeView | null {
  return overlay ? { overlay, confirmed: new Set(overlay.confirmed) } : null;
}

export function fnRuntime(n: TreeNode, view: RuntimeView | null): FnRuntime | undefined {
  return n.kind === "function" && n.function_id ? view?.overlay.functions[n.function_id] : undefined;
}

/** Was the static edge `parent -> node` seen at runtime? */
export function edgeConfirmed(fnParent: string | null, n: TreeNode, view: RuntimeView | null): boolean {
  return !!(fnParent && n.function_id && view?.confirmed.has(`${fnParent}>${n.function_id}`));
}

/** Callees seen at runtime directly under `fnParent` that the static tree lacks. */
export function runtimeExtras(fnParent: string | null, view: RuntimeView | null) {
  return (fnParent && view?.overlay.extras[fnParent]) || [];
}

export function shortId(functionId: string): string {
  return functionId.split(":").pop() ?? functionId;
}

export function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s` : `${Math.round(ms)}ms`;
}

/** Nearest enclosing *function* node above `id` (walks the index path). */
export function fnParentOf(root: TreeNode | null, id: string): string | null {
  if (!root) return null;
  let cur = root;
  let parent: string | null = null;
  for (const part of id.split(".").slice(1)) {
    if (cur.kind === "function" && cur.function_id) parent = cur.function_id;
    const next = cur.children?.[Number(part)];
    if (!next) break;
    cur = next;
  }
  return parent;
}

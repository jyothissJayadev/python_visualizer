import { useMemo, useState } from "react";
import type { FunctionInfo } from "../types";

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  functions: FunctionInfo[];
}

function buildTree(functions: FunctionInfo[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map(), functions: [] };

  for (const fn of functions) {
    const segments = fn.file_path.replace(/\\/g, "/").split("/");
    let node = root;
    let pathSoFar = "";
    for (const segment of segments) {
      pathSoFar = pathSoFar ? `${pathSoFar}/${segment}` : segment;
      if (!node.children.has(segment)) {
        node.children.set(segment, { name: segment, path: pathSoFar, children: new Map(), functions: [] });
      }
      node = node.children.get(segment)!;
    }
    node.functions.push(fn);
  }

  return root;
}

function matches(fn: FunctionInfo, query: string): boolean {
  if (!query) return true;
  const haystack = `${fn.qualified_name} ${fn.file_path}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function pruneEmpty(node: TreeNode, query: string): boolean {
  node.functions = node.functions.filter((fn) => matches(fn, query));
  for (const [key, child] of Array.from(node.children.entries())) {
    const keep = pruneEmpty(child, query);
    if (!keep) node.children.delete(key);
  }
  return node.functions.length > 0 || node.children.size > 0;
}

function TreeBranch({
  node,
  depth,
  selectedId,
  onSelect,
  forceOpen,
}: {
  node: TreeNode;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  forceOpen: boolean;
}) {
  const [open, setOpen] = useState(depth < 1);
  const isOpen = forceOpen || open;
  const isFile = node.functions.length > 0 && node.children.size === 0;
  const label = isFile ? node.name : `${node.name}/`;

  return (
    <div style={{ marginLeft: depth === 0 ? 0 : 12 }}>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{ cursor: "pointer", padding: "2px 0", color: "#8b93a7", fontFamily: "monospace", fontSize: 13 }}
      >
        {node.children.size > 0 || node.functions.length > 0 ? (isOpen ? "▾ " : "▸ ") : "  "}
        {label}
      </div>
      {isOpen && (
        <div style={{ marginLeft: 12 }}>
          {Array.from(node.children.values())
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((child) => (
              <TreeBranch
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedId={selectedId}
                onSelect={onSelect}
                forceOpen={forceOpen}
              />
            ))}
          {node.functions
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((fn) => (
              <div
                key={fn.function_id}
                onClick={() => onSelect(fn.function_id)}
                title={fn.qualified_name}
                style={{
                  cursor: "pointer",
                  padding: "2px 0 2px 18px",
                  fontFamily: "monospace",
                  fontSize: 13,
                  color: selectedId === fn.function_id ? "#111827" : "#374151",
                  background: selectedId === fn.function_id ? "#e0e7ff" : "transparent",
                  borderRadius: 4,
                }}
              >
                {fn.class_name ? `${fn.class_name}.${fn.name}` : fn.name}
                {fn.is_async ? " (async)" : ""}()
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

export function FunctionTree({
  functions,
  selectedId,
  onSelect,
}: {
  functions: FunctionInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");

  const tree = useMemo(() => {
    const root = buildTree(functions);
    if (query) pruneEmpty(root, query);
    return root;
  }, [functions, query]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <input
        placeholder="search functions..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{
          margin: "0 0 8px 0",
          padding: "6px 8px",
          fontSize: 13,
          border: "1px solid #d1d5db",
          borderRadius: 6,
        }}
      />
      <div style={{ overflowY: "auto", flex: 1 }}>
        {Array.from(tree.children.values())
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((child) => (
            <TreeBranch
              key={child.path}
              node={child}
              depth={0}
              selectedId={selectedId}
              onSelect={onSelect}
              forceOpen={query.length > 0}
            />
          ))}
      </div>
    </div>
  );
}

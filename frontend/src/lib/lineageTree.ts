/* lineageTree.ts — Hierarchical tree construction and navigation for end-to-end full-stack lineage */

import type { LineageChain } from "../types";

export type LineageNodeKind =
  | "brain"
  | "service"
  | "controller"
  | "route"
  | "client_api"
  | "ui_component"
  | "unexposed"
  | "note";

export interface LineageTreeNode {
  id: string;
  kind: LineageNodeKind;
  label: string;
  name: string;
  subLabel?: string;
  method?: string;
  app?: "brain" | "backend" | "frontend" | "admin";
  filePath?: string;
  line?: number;
  snippet?: string;
  badge?: string;
  badgeClass?: string;
  tags?: string[];
  raw?: unknown;
  children: LineageTreeNode[];
}

export interface FlattenedLineageRow {
  node: LineageTreeNode;
  depth: number;
  hasChildren: boolean;
  parentIndex: number;
}

export function fileName(path?: string): string {
  if (!path) return "";
  const parts = path.split("/");
  return parts.slice(-2).join("/");
}

export function methodClass(method?: string): string {
  if (!method) return "m-other";
  const m = method.toLowerCase();
  return ["get", "post", "put", "patch", "delete", "ws"].includes(m) ? `m-${m}` : "m-other";
}

/** Normalizes a URL path into lowercase segments with parameters wildcarded */
export function normalizeSegments(path: string): string[] {
  return path
    .replace(/^\/api\//, "")
    .replace(/^\//, "")
    .replace(/\/$/, "")
    .split("/")
    .filter(Boolean)
    .map((seg) =>
      seg.startsWith(":") || (seg.startsWith("{") && seg.endsWith("}")) || seg.startsWith("$")
        ? "*"
        : seg.toLowerCase(),
    );
}

/** Returns true if an Express route path matches a Client API url */
export function pathsMatch(routePath: string, clientUrl: string): boolean {
  const s1 = normalizeSegments(routePath);
  const s2 = normalizeSegments(clientUrl);
  if (s1.length !== s2.length) return false;
  return s1.every((seg, i) => seg === "*" || s2[i] === "*" || seg === s2[i]);
}

/** Splits "/a/{id}/b" or "/a/:id/b" into parts so params can be colored */
export function pathParts(path: string): { text: string; param: boolean }[] {
  return path
    .split(/(\{[^}]+\}|:[a-zA-Z0-9_]+)/g)
    .filter(Boolean)
    .map((text) => ({
      text,
      param: text.startsWith("{") || text.startsWith(":"),
    }));
}

/** Builds the multi-level hierarchical tree from a LineageChain */
export function buildLineageTree(chain: LineageChain): LineageTreeNode {
  const rootId = `brain:${chain.id}`;
  const root: LineageTreeNode = {
    id: rootId,
    kind: "brain",
    label: `${chain.method} ${chain.path}`,
    name: chain.endpoint.handler_name ? `${chain.endpoint.handler_name}()` : chain.path,
    subLabel: chain.endpoint.summary || chain.endpoint.handler_id,
    method: chain.method,
    app: "brain",
    filePath: chain.endpoint.file_path,
    line: chain.endpoint.line,
    badge: "FastAPI",
    badgeClass: "badge-brain",
    tags: chain.endpoint.tags,
    raw: chain.endpoint,
    children: [],
  };

  // 1. Unexposed endpoint case
  if (!chain.backend || chain.backend.length === 0) {
    root.children.push({
      id: `${rootId}/unexposed`,
      kind: "unexposed",
      label: "Internal Brain Endpoint",
      name: "Not exposed in backend (no service calls found)",
      subLabel: "Direct FastAPI route or internal worker endpoint",
      children: [],
    });
    return root;
  }

  // 2. Group backend bridges by service function & location
  const serviceGroups = new Map<
    string,
    {
      service: (typeof chain.backend)[0]["service"];
      bridges: typeof chain.backend;
    }
  >();

  for (const b of chain.backend) {
    const sKey = `${b.service.serviceFunc}:${b.service.file}:${b.service.line}`;
    if (!serviceGroups.has(sKey)) {
      serviceGroups.set(sKey, { service: b.service, bridges: [] });
    }
    serviceGroups.get(sKey)!.bridges.push(b);
  }

  const attachedClientKeys = new Set<string>();

  for (const [sKey, group] of serviceGroups) {
    const sNodeId = `${rootId}/srv:${sKey}`;
    const sNode: LineageTreeNode = {
      id: sNodeId,
      kind: "service",
      label: group.service.serviceFunc,
      name: `${group.service.serviceFunc}()`,
      subLabel: `${group.service.method} ${group.service.cleanPath || group.service.rawPath}`,
      method: group.service.method,
      app: "backend",
      filePath: group.service.file,
      line: group.service.line,
      badge: "Backend Service",
      badgeClass: "badge-service",
      raw: group.service,
      children: [],
    };

    for (const b of group.bridges) {
      if (b.controller) {
        const cKey = `${b.controller.controllerFunc}:${b.controller.file}:${b.controller.line}`;
        const cNodeId = `${sNodeId}/ctrl:${cKey}`;
        const cNode: LineageTreeNode = {
          id: cNodeId,
          kind: "controller",
          label: b.controller.controllerFunc,
          name: `${b.controller.controllerFunc}()`,
          subLabel: "Controller Handler",
          app: "backend",
          filePath: b.controller.file,
          line: b.controller.line,
          badge: "Controller",
          badgeClass: "badge-controller",
          raw: b.controller,
          children: [],
        };

        if (b.routes && b.routes.length > 0) {
          for (const r of b.routes) {
            const rKey = `${r.method}:${r.fullPath}:${r.file}:${r.line}`;
            const rNodeId = `${cNodeId}/route:${rKey}`;
            const rNode: LineageTreeNode = {
              id: rNodeId,
              kind: "route",
              label: `${r.method} ${r.fullPath}`,
              name: r.fullPath,
              subLabel: r.subPath,
              method: r.method,
              app: "backend",
              filePath: r.file,
              line: r.line,
              badge: "Express Route",
              badgeClass: "badge-route",
              raw: r,
              children: [],
            };

            // Match Client APIs to this Express route
            const matchingClients = (chain.clients || []).filter((cl) => {
              const clientUrl = cl.api.url || cl.api.rawUrl || "";
              return pathsMatch(r.fullPath, clientUrl);
            });

            for (const cl of matchingClients) {
              const clKey = `${cl.app}:${cl.api.apiFunc}:${cl.api.file}:${cl.api.line}`;
              attachedClientKeys.add(clKey);
              const clNodeId = `${rNodeId}/cl:${clKey}`;
              const clNode: LineageTreeNode = {
                id: clNodeId,
                kind: "client_api",
                label: cl.api.apiFunc,
                name: `${cl.api.apiFunc}()`,
                subLabel: `${cl.api.method} ${cl.api.url}`,
                method: cl.api.method,
                app: cl.app,
                filePath: cl.api.file,
                line: cl.api.line,
                badge: cl.app === "admin" ? "Admin API" : "Frontend API",
                badgeClass: cl.app === "admin" ? "badge-admin" : "badge-frontend",
                raw: cl.api,
                children: [],
              };

              // Attach React UI usages
              if (cl.ui && cl.ui.length > 0) {
                for (const ui of cl.ui) {
                  const uiKey = `${ui.app}:${ui.component}:${ui.callerFunc}:${ui.file}:${ui.line}`;
                  const uiNodeId = `${clNodeId}/ui:${uiKey}`;
                  clNode.children.push({
                    id: uiNodeId,
                    kind: "ui_component",
                    label: `<${ui.component} />`,
                    name: `<${ui.component} />`,
                    subLabel:
                      ui.callerFunc && ui.callerFunc !== "component_body"
                        ? `via ${ui.callerFunc}()`
                        : undefined,
                    app: ui.app,
                    filePath: ui.file,
                    line: ui.line,
                    snippet: ui.snippet,
                    badge: ui.app === "admin" ? "Admin UI" : "Frontend UI",
                    badgeClass: ui.app === "admin" ? "badge-admin" : "badge-frontend",
                    raw: ui,
                    children: [],
                  });
                }
              } else {
                clNode.children.push({
                  id: `${clNodeId}/no-ui`,
                  kind: "note",
                  label: "No UI callers detected",
                  name: "No React component usages found",
                  subLabel: "API method exists but has no active component callers",
                  children: [],
                });
              }

              rNode.children.push(clNode);
            }

            if (matchingClients.length === 0) {
              rNode.children.push({
                id: `${rNodeId}/no-client`,
                kind: "note",
                label: "No Client API",
                name: "Not called by frontend or admin clients",
                subLabel: "Express route is exposed but not called via client API",
                children: [],
              });
            }

            cNode.children.push(rNode);
          }
        } else {
          cNode.children.push({
            id: `${cNodeId}/no-route`,
            kind: "note",
            label: "No Route Mounted",
            name: "No Express route found mounting this controller",
            children: [],
          });
        }

        sNode.children.push(cNode);
      } else if (b.routes && b.routes.length > 0) {
        // Direct routes without controller
        for (const r of b.routes) {
          const rKey = `${r.method}:${r.fullPath}:${r.file}:${r.line}`;
          sNode.children.push({
            id: `${sNodeId}/route:${rKey}`,
            kind: "route",
            label: `${r.method} ${r.fullPath}`,
            name: r.fullPath,
            method: r.method,
            app: "backend",
            filePath: r.file,
            line: r.line,
            badge: "Express Route",
            badgeClass: "badge-route",
            raw: r,
            children: [],
          });
        }
      } else {
        sNode.children.push({
          id: `${sNodeId}/internal`,
          kind: "note",
          label: "Internal Service",
          name: "Service not exported via controller or route",
          children: [],
        });
      }
    }

    root.children.push(sNode);
  }

  // 3. Attach any client calls that didn't match Express routes
  const unmatchedClients = (chain.clients || []).filter((cl) => {
    const clKey = `${cl.app}:${cl.api.apiFunc}:${cl.api.file}:${cl.api.line}`;
    return !attachedClientKeys.has(clKey);
  });

  if (unmatchedClients.length > 0) {
    const unmatchedNode: LineageTreeNode = {
      id: `${rootId}/unmatched-clients`,
      kind: "note",
      label: "Direct Client Calls",
      name: "Client API calls to this endpoint",
      subLabel: "Direct calls or unrouted backend calls",
      children: [],
    };

    for (const cl of unmatchedClients) {
      const clKey = `${cl.app}:${cl.api.apiFunc}:${cl.api.file}:${cl.api.line}`;
      const clNode: LineageTreeNode = {
        id: `${unmatchedNode.id}/cl:${clKey}`,
        kind: "client_api",
        label: cl.api.apiFunc,
        name: `${cl.api.apiFunc}()`,
        subLabel: `${cl.api.method} ${cl.api.url}`,
        method: cl.api.method,
        app: cl.app,
        filePath: cl.api.file,
        line: cl.api.line,
        badge: cl.app === "admin" ? "Admin API" : "Frontend API",
        badgeClass: cl.app === "admin" ? "badge-admin" : "badge-frontend",
        raw: cl.api,
        children: [],
      };

      for (const ui of cl.ui || []) {
        const uiKey = `${ui.app}:${ui.component}:${ui.callerFunc}:${ui.file}:${ui.line}`;
        clNode.children.push({
          id: `${clNode.id}/ui:${uiKey}`,
          kind: "ui_component",
          label: `<${ui.component} />`,
          name: `<${ui.component} />`,
          subLabel: ui.callerFunc ? `via ${ui.callerFunc}()` : undefined,
          app: ui.app,
          filePath: ui.file,
          line: ui.line,
          snippet: ui.snippet,
          badge: ui.app === "admin" ? "Admin UI" : "Frontend UI",
          badgeClass: ui.app === "admin" ? "badge-admin" : "badge-frontend",
          raw: ui,
          children: [],
        });
      }

      unmatchedNode.children.push(clNode);
    }

    root.children.push(unmatchedNode);
  }

  return root;
}

/** Flattens the hierarchy tree into an array of visible rows based on expanded set */
export function flattenLineageTree(
  root: LineageTreeNode,
  expanded: Set<string>,
): FlattenedLineageRow[] {
  const rows: FlattenedLineageRow[] = [];

  function walk(node: LineageTreeNode, depth: number, parentIndex: number) {
    const currentIndex = rows.length;
    const hasChildren = Boolean(node.children && node.children.length > 0);
    rows.push({
      node,
      depth,
      hasChildren,
      parentIndex,
    });

    if (hasChildren && expanded.has(node.id)) {
      for (const child of node.children) {
        walk(child, depth + 1, currentIndex);
      }
    }
  }

  walk(root, 0, -1);
  return rows;
}

/** Collects all node IDs in a subtree */
export function collectAllNodeIds(node: LineageTreeNode): string[] {
  const ids: string[] = [node.id];
  for (const c of node.children) {
    ids.push(...collectAllNodeIds(c));
  }
  return ids;
}

/** Collects node IDs up to a given depth level */
export function collectNodeIdsToLevel(
  node: LineageTreeNode,
  maxDepth: number,
  currentDepth = 0,
): string[] {
  if (currentDepth >= maxDepth) return [];
  const ids: string[] = [node.id];
  for (const c of node.children) {
    ids.push(...collectNodeIdsToLevel(c, maxDepth, currentDepth + 1));
  }
  return ids;
}

/** Searches tree for matching text in label, name, file or snippet */
export function searchLineageTree(
  root: LineageTreeNode,
  needle: string,
): { hits: string[]; ancestors: Set<string> } {
  const q = needle.toLowerCase().trim();
  const hits: string[] = [];
  const ancestors = new Set<string>();

  if (!q) return { hits, ancestors };

  function walk(node: LineageTreeNode, trail: string[]) {
    const hay = `${node.label} ${node.name} ${node.subLabel ?? ""} ${node.filePath ?? ""} ${node.snippet ?? ""}`.toLowerCase();
    if (node.id !== root.id && hay.includes(q)) {
      hits.push(node.id);
      for (const a of trail) ancestors.add(a);
    }
    for (const c of node.children) {
      walk(c, [...trail, node.id]);
    }
  }

  walk(root, []);
  return { hits, ancestors };
}

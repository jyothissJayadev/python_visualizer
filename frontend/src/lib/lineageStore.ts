import type {
  LineageAnalysisResponse,
  LineageChain,
  LineageChainStatus,
  LineageSummary,
} from "../types";
import { lineageApi } from "./lineageApi";
import {
  buildLineageTree,
  collectAllNodeIds,
  collectNodeIdsToLevel,
  searchLineageTree,
  type LineageTreeNode,
} from "./lineageTree";

export type LineageViewMode = "tree" | "graph" | "swimlane";

export interface NodeDetailModal {
  type:
    | "brain_endpoint"
    | "backend_service"
    | "backend_controller"
    | "backend_route"
    | "client_api"
    | "client_ui"
    | "note";
  title: string;
  subtitle?: string;
  file?: string;
  line?: number;
  snippet?: string;
  data: unknown;
}

export interface LineageSnapshot {
  loading: boolean;
  rescanning: boolean;
  /** the code on disk changed since the shown data was scanned */
  stale: boolean;
  /** a scan is running (started by the file watcher or the Rescan button) */
  scanning: boolean;
  error: string | null;
  data: LineageAnalysisResponse | null;
  chains: LineageChain[];
  summary: LineageSummary | null;
  selectedChainId: string | null;
  selectedChain: LineageChain | null;

  searchQuery: string;
  filterStatus: LineageChainStatus | "all";
  filterDomain: string;
  filterApp: "all" | "admin" | "frontend";

  selectedNodeDetail: NodeDetailModal | null;

  // View slider & Tree State
  viewMode: LineageViewMode;
  expandedTreeNodes: Set<string>;
  selectedTreeNodeId: string | null;
  treeSearch: string;
  searchHits: string[];
  searchIndex: number;
  drawerOpen: boolean;
  tree: LineageTreeNode | null;
}

class LineageStore {
  private listeners = new Set<() => void>();
  private snapshot: LineageSnapshot = {
    loading: false,
    rescanning: false,
    stale: false,
    scanning: false,
    error: null,
    data: null,
    chains: [],
    summary: null,
    selectedChainId: null,
    selectedChain: null,
    searchQuery: "",
    filterStatus: "all",
    filterDomain: "all",
    filterApp: "all",
    selectedNodeDetail: null,

    viewMode: "tree",
    expandedTreeNodes: new Set<string>(),
    selectedTreeNodeId: null,
    treeSearch: "",
    searchHits: [],
    searchIndex: 0,
    drawerOpen: false,
    tree: null,
  };

  constructor() {
    // Initial fetch
    void this.load();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): LineageSnapshot => this.snapshot;

  private emit() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private update(patch: Partial<LineageSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };

    // If chains or selectedChainId changed, recalculate selectedChain & tree
    if (patch.chains !== undefined || patch.selectedChainId !== undefined) {
      const id = this.snapshot.selectedChainId;
      const chain =
        this.snapshot.chains.find((c) => c.id === id || c.path === id) ||
        (this.snapshot.chains.length > 0 ? this.snapshot.chains[0] : null);

      this.snapshot.selectedChain = chain;

      if (chain) {
        const tree = buildLineageTree(chain);
        this.snapshot.tree = tree;
        // Expand all nodes by default
        this.snapshot.expandedTreeNodes = new Set(collectAllNodeIds(tree));
      } else {
        this.snapshot.tree = null;
        this.snapshot.expandedTreeNodes = new Set();
      }
    }

    this.emit();
  }

  async load(force: boolean = false) {
    if (this.snapshot.loading) return;
    this.update({ loading: true, error: null });

    try {
      const data = await lineageApi.getLineage(force);
      this.update({
        loading: false,
        stale: !!data.stale,
        scanning: data.status === "scanning",
        data,
        chains: data.chains || [],
        summary: data.summary || null,
        selectedChainId: this.snapshot.selectedChainId || (data.chains?.[0]?.id ?? null),
      });
    } catch (err) {
      this.update({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async rescan() {
    if (this.snapshot.rescanning) return;
    this.update({ rescanning: true, error: null });

    try {
      const data = await lineageApi.rescan();
      this.update({
        rescanning: false,
        stale: false,
        scanning: false,
        data,
        chains: data.chains || [],
        summary: data.summary || null,
        selectedChainId: this.snapshot.selectedChainId || (data.chains?.[0]?.id ?? null),
      });
    } catch (err) {
      this.update({
        rescanning: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** WebSocket `lineage_status` / `lineage_updated`: the watcher saw a source change, or finished a rescan. */
  onServerMessage(msg: { kind: string; stale?: boolean; status?: string }) {
    this.update({ stale: !!msg.stale, scanning: msg.status === "scanning" });
    if (msg.kind === "lineage_updated") void this.reload();
  }

  private async reload() {
    try {
      const data = await lineageApi.getLineage(false);
      this.update({
        stale: !!data.stale,
        scanning: false,
        data,
        chains: data.chains || [],
        summary: data.summary || null,
        selectedChainId: this.snapshot.selectedChainId || (data.chains?.[0]?.id ?? null),
      });
    } catch {
      /* keep what is shown; the next message retries */
    }
  }

  selectChain(id: string | null) {
    if (this.snapshot.selectedChainId === id) return;
    this.update({ selectedChainId: id });
  }

  setSearch(q: string) {
    this.update({ searchQuery: q });
  }

  setStatusFilter(status: LineageChainStatus | "all") {
    this.update({ filterStatus: status });
  }

  setDomainFilter(domain: string) {
    this.update({ filterDomain: domain });
  }

  setAppFilter(app: "all" | "admin" | "frontend") {
    this.update({ filterApp: app });
  }

  // ── View Mode Toggle (Tree vs Swimlane) ──────────────────────────────────
  setViewMode(mode: LineageViewMode) {
    if (this.snapshot.viewMode === mode) return;
    this.update({ viewMode: mode });
  }

  // ── Tree Expansion / Collapse ───────────────────────────────────────────
  toggleTreeNode(id: string) {
    const next = new Set(this.snapshot.expandedTreeNodes);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.update({ expandedTreeNodes: next });
  }

  expandTreeNode(id: string) {
    if (this.snapshot.expandedTreeNodes.has(id)) return;
    const next = new Set(this.snapshot.expandedTreeNodes);
    next.add(id);
    this.update({ expandedTreeNodes: next });
  }

  collapseTreeNode(id: string) {
    if (!this.snapshot.expandedTreeNodes.has(id)) return;
    const next = new Set(this.snapshot.expandedTreeNodes);
    next.delete(id);
    this.update({ expandedTreeNodes: next });
  }

  expandAllTreeNodes() {
    if (!this.snapshot.tree) return;
    const all = collectAllNodeIds(this.snapshot.tree);
    this.update({ expandedTreeNodes: new Set(all) });
  }

  collapseAllTreeNodes() {
    if (!this.snapshot.tree) return;
    // Keep root node open
    this.update({ expandedTreeNodes: new Set([this.snapshot.tree.id]) });
  }

  expandTreeToLevel(maxDepth: number) {
    if (!this.snapshot.tree) return;
    const ids = collectNodeIdsToLevel(this.snapshot.tree, maxDepth);
    this.update({ expandedTreeNodes: new Set(ids) });
  }

  // ── Tree Search ─────────────────────────────────────────────────────────
  setTreeSearch(query: string) {
    const q = query.trim();
    if (!q || !this.snapshot.tree) {
      this.update({ treeSearch: query, searchHits: [], searchIndex: 0 });
      return;
    }

    const { hits, ancestors } = searchLineageTree(this.snapshot.tree, q);
    // Expand ancestors of search hits so matches are visible
    const nextExpanded = new Set(this.snapshot.expandedTreeNodes);
    for (const a of ancestors) nextExpanded.add(a);

    this.update({
      treeSearch: query,
      searchHits: hits,
      searchIndex: 0,
      expandedTreeNodes: nextExpanded,
      selectedTreeNodeId: hits[0] ?? this.snapshot.selectedTreeNodeId,
    });
  }

  stepSearch(dir: number) {
    const { searchHits, searchIndex } = this.snapshot;
    if (!searchHits.length) return;
    const nextIndex = (searchIndex + dir + searchHits.length) % searchHits.length;
    this.update({
      searchIndex: nextIndex,
      selectedTreeNodeId: searchHits[nextIndex],
    });
  }

  // ── Selection & Code Inspector Drawer ───────────────────────────────────
  selectTreeNode(id: string, detail?: NodeDetailModal) {
    this.update({
      selectedTreeNodeId: id,
      selectedNodeDetail: detail ?? this.snapshot.selectedNodeDetail,
      drawerOpen: detail !== undefined ? true : this.snapshot.drawerOpen,
    });
  }

  selectNodeDetail(detail: NodeDetailModal | null) {
    this.update({
      selectedNodeDetail: detail,
      drawerOpen: detail !== null,
    });
  }

  toggleDrawer() {
    this.update({ drawerOpen: !this.snapshot.drawerOpen });
  }

  setDrawerOpen(open: boolean) {
    this.update({ drawerOpen: open });
  }
}

export const lineageStore = new LineageStore();

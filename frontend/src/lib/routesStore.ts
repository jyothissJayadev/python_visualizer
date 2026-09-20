/* routesStore.ts — state of the Routes view.

   Holds the endpoint listing, the selected endpoint's *lazily loaded*
   hierarchy (nodes are fetched by depth; a node cut by the depth limit
   carries `children_count` and is fetched when expanded), expansion /
   selection / search state, and view preferences. Exposed to React through
   useSyncExternalStore (see useRoutes.ts), like the terminal store. */

import {
  routesApi,
  ApiError,
  type AnalysisStatus,
  type EndpointData,
  type EndpointDetail,
  type FunctionDetail,
  type LibraryCall,
  type RoutesListing,
  type RuntimeOverlay,
  type TreeNode,
  type TreeStats,
} from "./routesApi";
import { autoExpand, findNode, idsWithinDepth, replaceAt, searchTree } from "./routesUi";
import { store } from "./store";

const PREFS_KEY = "brainTerminal.routes.prefs";
const INITIAL_DEPTH = 4;
const SUBTREE_DEPTH = 3;
export const MAX_DEPTH = 12;

export type ViewMode = "tree" | "graph" | "data";

export interface TreeState {
  endpointId: string;
  generation: number;
  root: TreeNode;
  stats: TreeStats;
  loadedDepth: number;
}

export interface RoutesSnapshot {
  listing: RoutesListing | null;
  listingError: string | null;
  analysis: AnalysisStatus | null;
  rescanning: boolean;

  selectedId: string | null;
  endpoint: EndpointDetail | null;
  tree: TreeState | null;
  treeLoading: boolean;
  treeError: string | null;
  loadingNodes: Set<string>;

  expanded: Set<string>;
  selectedNodeId: string | null;
  scrollTo: { id: string; tick: number } | null;

  fnDetails: Record<string, FunctionDetail | "loading" | "error">;
  /** library / built-in / unresolved calls of a node, fetched when it is selected */
  nodeLibrary: Record<string, { items: LibraryCall[]; more: number; below: string[] } | "loading">;

  runtime: RuntimeOverlay | null;
  /** database tables the selected endpoint touches (derived from the code) */
  data: EndpointData | null;
  selectedTable: string | null;
  /** draw database tables as nodes attached to the functions that use them (Graph view) */
  showTables: boolean;
  dimUnobserved: boolean;
  arming: boolean;

  // view state
  view: ViewMode;
  drawerOpen: boolean;
  sidebarSearch: string;
  methodFilter: Set<string>;
  collapsedGroups: Set<string>;
  treeSearch: string;
  searchHits: string[];
  searchIndex: number;
}

interface Prefs {
  view: ViewMode;
  collapsedGroups: string[];
  dimUnobserved: boolean;
  drawerOpen?: boolean;
  showTables?: boolean;
}

function loadPrefs(): Partial<Prefs> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
  } catch {
    return {};
  }
}

function initial(): RoutesSnapshot {
  const p = loadPrefs();
  return {
    listing: null,
    listingError: null,
    analysis: null,
    rescanning: false,
    selectedId: null,
    endpoint: null,
    tree: null,
    treeLoading: false,
    treeError: null,
    loadingNodes: new Set(),
    expanded: new Set(),
    selectedNodeId: null,
    scrollTo: null,
    fnDetails: {},
    nodeLibrary: {},
    runtime: null,
    data: null,
    selectedTable: null,
    showTables: p.showTables !== false,
    dimUnobserved: p.dimUnobserved !== false,
    arming: false,
    view: p.view === "graph" || p.view === "data" ? p.view : "tree",
    drawerOpen: p.drawerOpen !== false,
    sidebarSearch: "",
    methodFilter: new Set(),
    collapsedGroups: new Set(p.collapsedGroups ?? []),
    treeSearch: "",
    searchHits: [],
    searchIndex: 0,
  };
}

type Listener = () => void;

class RoutesStore {
  private s: RoutesSnapshot = initial();
  private listeners = new Set<Listener>();
  private started = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private token = 0; // bumped on every endpoint selection; stale responses are dropped
  private scrollTick = 0;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): RoutesSnapshot => this.s;

  private set(patch: Partial<RoutesSnapshot>) {
    this.s = { ...this.s, ...patch };
    this.listeners.forEach((l) => l());
  }

  private savePrefs() {
    try {
      const prefs: Prefs = {
        view: this.s.view,
        collapsedGroups: [...this.s.collapsedGroups],
        dimUnobserved: this.s.dimUnobserved,
        drawerOpen: this.s.drawerOpen,
        showTables: this.s.showTables,
      };
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* storage unavailable — prefs just won't persist */
    }
  }

  setDrawerOpen(open: boolean) {
    if (this.s.drawerOpen === open) return;
    this.set({ drawerOpen: open });
    this.savePrefs();
  }

  toggleDrawer() {
    this.setDrawerOpen(!this.s.drawerOpen);
  }

  // ── listing ──────────────────────────────────────────────────────────
  start() {
    if (this.started) return;
    this.started = true;
    void this.loadListing();
  }

  async loadListing() {
    try {
      const listing = await routesApi.list();
      this.set({ listing, analysis: listing.analysis, listingError: null });
      if (!listing.analysis.ready) this.pollUntilReady();
    } catch (err) {
      this.set({ listingError: err instanceof Error ? err.message : String(err) });
      this.pollUntilReady(3000);
    }
  }

  private pollUntilReady(delay = 1000) {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.loadListing().then(() => {
        const a = this.s.analysis;
        if (a?.ready && this.s.selectedId && !this.s.tree && !this.s.treeLoading) {
          void this.select(this.s.selectedId);
        }
      });
    }, delay);
  }

  async rescan() {
    if (this.s.rescanning) return;
    this.set({ rescanning: true });
    try {
      const res = await routesApi.rescan();
      store.pushToast(res.changed ? `Re-analyzed · ${res.endpoint_count} endpoints` : "Analysis is up to date");
      await this.loadListing();
      if (this.s.selectedId) await this.select(this.s.selectedId);
    } catch (err) {
      store.pushToast("Rescan failed: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      this.set({ rescanning: false });
    }
  }

  /** Pushed by the backend over the dashboard WebSocket (socket.ts). */
  onAnalysisMessage(msg: { kind: string } & Partial<AnalysisStatus>) {
    const prev = this.s.analysis;
    const analysis = { ...(prev ?? {}), ...msg } as AnalysisStatus;
    this.set({ analysis });
    if (msg.kind === "analysis_updated") {
      if (prev && prev.generation > 0) {
        store.pushToast(`Code changed — routes re-analyzed (${analysis.endpoint_count} endpoints)`);
      }
      void this.loadListing().then(() => {
        if (this.s.selectedId) void this.select(this.s.selectedId, { keepView: true });
      });
    }
  }

  // ── endpoint + tree ──────────────────────────────────────────────────
  async select(id: string, opts: { keepView?: boolean } = {}) {
    const token = ++this.token;
    const same = this.s.selectedId === id;
    this.set({
      selectedId: id,
      treeLoading: true,
      treeError: null,
      ...(same && opts.keepView ? {} : { tree: null, endpoint: null, selectedNodeId: null, expanded: new Set(), runtime: null, data: null, selectedTable: null }),
      fnDetails: {},
      nodeLibrary: {},
      treeSearch: "",
      searchHits: [],
      searchIndex: 0,
    });
    try {
      const [endpoint, tree] = await Promise.all([
        routesApi.endpoint(id),
        routesApi.tree(id, "0", INITIAL_DEPTH),
      ]);
      if (token !== this.token) return;
      this.set({
        endpoint,
        treeLoading: false,
        tree: {
          endpointId: id,
          generation: tree.generation,
          root: tree.node,
          stats: tree.stats,
          loadedDepth: INITIAL_DEPTH,
        },
        expanded: autoExpand(tree.node),
      });
      void this.loadRuntime();
      void this.loadData(id);
    } catch (err) {
      if (token !== this.token) return;
      const notReady = err instanceof ApiError && err.status === 503;
      this.set({
        treeLoading: false,
        treeError: notReady ? "The analysis is still running — this will load automatically." : String(err instanceof Error ? err.message : err),
      });
      if (notReady) this.pollUntilReady();
    }
  }

  private async loadSubtree(nodeId: string, depth = SUBTREE_DEPTH) {
    const tree = this.s.tree;
    if (!tree) return;
    const token = this.token;
    this.set({ loadingNodes: new Set(this.s.loadingNodes).add(nodeId) });
    try {
      const res = await routesApi.tree(tree.endpointId, nodeId, depth);
      const cur = this.s.tree;
      if (token !== this.token || !cur || cur.generation !== res.generation) return;
      const loading = new Set(this.s.loadingNodes);
      loading.delete(nodeId);
      this.set({
        loadingNodes: loading,
        tree: { ...cur, root: replaceAt(cur.root, nodeId, res.node) },
        expanded: new Set(this.s.expanded).add(nodeId),
      });
    } catch (err) {
      const loading = new Set(this.s.loadingNodes);
      loading.delete(nodeId);
      this.set({ loadingNodes: loading });
      store.pushToast("Could not load subtree: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  toggle(nodeId: string) {
    const tree = this.s.tree;
    if (!tree) return;
    const node = findNode(tree.root, nodeId);
    if (!node) return;
    if (this.s.expanded.has(nodeId)) {
      const next = new Set(this.s.expanded);
      next.delete(nodeId);
      this.set({ expanded: next });
    } else if (node.children_count && !node.children) {
      void this.loadSubtree(nodeId);
    } else {
      this.set({ expanded: new Set(this.s.expanded).add(nodeId) });
    }
  }

  expand(nodeId: string) {
    if (!this.s.expanded.has(nodeId)) this.toggle(nodeId);
  }

  collapse(nodeId: string) {
    if (this.s.expanded.has(nodeId)) this.toggle(nodeId);
  }

  collapseAll() {
    const root = this.s.tree?.root;
    if (root) this.set({ expanded: new Set([root.id]) });
  }

  /** Load the whole hierarchy `levels` deep and expand it. */
  async expandLevels(levels: number) {
    const tree = this.s.tree;
    if (!tree) return;
    const token = this.token;
    this.set({ treeLoading: true });
    try {
      const res = await routesApi.tree(tree.endpointId, "0", Math.min(levels, MAX_DEPTH));
      if (token !== this.token) return;
      this.set({
        treeLoading: false,
        tree: { ...tree, generation: res.generation, root: res.node, stats: res.stats, loadedDepth: levels },
        expanded: new Set([...autoExpand(res.node), ...idsWithinDepth(res.node, levels)]),
      });
    } catch (err) {
      this.set({ treeLoading: false });
      store.pushToast("Could not load: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  // ── selection / search ───────────────────────────────────────────────
  selectNode(id: string | null) {
    this.set({ selectedNodeId: id, ...(id ? { drawerOpen: true } : {}) });
    const node = id ? findNode(this.s.tree?.root ?? null, id) : null;
    if (node && ((node.meta?.library_count ?? 0) > 0 || (node.meta?.below_count ?? 0) > 0)) void this.loadNodeLibrary(node.id);
  }

  /** The calls a function makes that are not in the hierarchy (library,
      built-in, unresolved). Sent only for the node asked about, to keep the
      tree payload small. */
  async loadNodeLibrary(nodeId: string) {
    const tree = this.s.tree;
    if (!tree || this.s.nodeLibrary[nodeId]) return;
    this.set({ nodeLibrary: { ...this.s.nodeLibrary, [nodeId]: "loading" } });
    try {
      const res = await routesApi.tree(tree.endpointId, nodeId, 0);
      const items = res.node.meta?.library ?? [];
      const below = res.node.meta?.below ?? [];
      this.set({ nodeLibrary: { ...this.s.nodeLibrary, [nodeId]: { items, more: res.node.meta?.library_more ?? 0, below } } });
    } catch {
      this.set({ nodeLibrary: { ...this.s.nodeLibrary, [nodeId]: { items: [], more: 0, below: [] } } });
    }
  }

  scrollToNode(id: string) {
    this.set({ scrollTo: { id, tick: ++this.scrollTick } });
  }

  setTreeSearch(text: string) {
    const tree = this.s.tree;
    const needle = text.trim().toLowerCase();
    if (!tree || needle.length < 2) {
      this.set({ treeSearch: text, searchHits: [], searchIndex: 0 });
      return;
    }
    const { hits, ancestors } = searchTree(tree.root, needle);
    this.set({
      treeSearch: text,
      searchHits: hits,
      searchIndex: 0,
      expanded: new Set([...this.s.expanded, ...ancestors]),
    });
    if (hits.length) this.scrollToNode(hits[0]);
  }

  stepSearch(dir: 1 | -1) {
    const { searchHits, searchIndex } = this.s;
    if (!searchHits.length) return;
    const next = (searchIndex + dir + searchHits.length) % searchHits.length;
    this.set({ searchIndex: next, selectedNodeId: searchHits[next] });
    this.scrollToNode(searchHits[next]);
  }

  // ── view preferences ─────────────────────────────────────────────────
  setView(view: ViewMode) {
    this.set({ view });
    this.savePrefs();
  }

  setSidebarSearch(text: string) {
    this.set({ sidebarSearch: text });
  }

  toggleMethod(method: string) {
    const next = new Set(this.s.methodFilter);
    if (!next.delete(method)) next.add(method);
    this.set({ methodFilter: next });
  }

  toggleGroup(prefix: string) {
    const next = new Set(this.s.collapsedGroups);
    if (!next.delete(prefix)) next.add(prefix);
    this.set({ collapsedGroups: next });
    this.savePrefs();
  }

  // ── database tables ──────────────────────────────────────────────────
  async loadData(id: string) {
    try {
      const data = await routesApi.data(id);
      if (this.s.selectedId === id) this.set({ data });
    } catch {
      /* optional: the hierarchy works without it */
    }
  }

  setSelectedTable(id: string | null) {
    this.set({ selectedTable: id, ...(id ? { drawerOpen: true } : {}) });
  }

  /** Jump to the Data view with a table selected (from a row chip / drawer). */
  openTable(id: string) {
    this.set({ view: "data", selectedTable: id, drawerOpen: true });
    this.savePrefs();
  }

  /** Show a function in the hierarchy: load whatever is missing on the way
      down to `path`, open every ancestor, select it, scroll to it. */
  async revealNode(path: string) {
    const parts = path.split(".");
    const ancestors = () => parts.slice(0, -1).map((_, k) => parts.slice(0, k + 1).join("."));
    for (let i = 0; i < 6 && this.s.tree && !findNode(this.s.tree.root, path); i++) {
      let holder: TreeNode | null = null;
      for (let k = parts.length - 1; k >= 1 && !holder; k--) {
        const n = findNode(this.s.tree.root, parts.slice(0, k).join("."));
        if (n) holder = n;
      }
      if (!holder || holder.children || !holder.children_count) break;
      await this.loadSubtree(holder.id, 6);
    }
    this.set({
      view: "tree",
      selectedNodeId: path,
      expanded: new Set([...this.s.expanded, ...ancestors()]),
      drawerOpen: true,
    });
    this.savePrefs();
    this.scrollToNode(path);
  }

  // ── runtime overlay ──────────────────────────────────────────────────
  private runtimeTimer: ReturnType<typeof setTimeout> | null = null;

  async loadRuntime() {
    const id = this.s.selectedId;
    if (!id) return;
    try {
      const runtime = await routesApi.runtime(id);
      if (this.s.selectedId === id) this.set({ runtime });
    } catch {
      /* analysis not ready / endpoint gone — the overlay is optional */
    }
  }

  /** New trace activity (socket.ts): refresh the overlay, debounced so a
      burst of requests costs one fetch. */
  onTraceActivity() {
    if (!this.s.selectedId) return;
    if (this.runtimeTimer) clearTimeout(this.runtimeTimer);
    this.runtimeTimer = setTimeout(() => {
      this.runtimeTimer = null;
      void this.loadRuntime();
    }, 500);
  }

  setShowTables(on: boolean) {
    this.set({ showTables: on });
    this.savePrefs();
  }

  setDimUnobserved(on: boolean) {
    this.set({ dimUnobserved: on });
    this.savePrefs();
  }

  /** Arm / disarm the selected endpoint's handler (deep: everything under it). */
  async arm(armed: boolean) {
    const id = this.s.selectedId;
    if (!id || this.s.arming) return;
    this.set({ arming: true });
    try {
      const res = await routesApi.arm(id, armed);
      if (!res.ok) store.pushToast(res.error ?? "Could not apply selection");
      else if (res.unresolved?.length) store.pushToast(`Armed, but brain could not resolve: ${res.unresolved.map((u) => u.id).join(", ")}`);
      else store.pushToast(armed ? "Handler armed (deep) — send a request to brain" : "Handler disarmed");
      await this.loadRuntime();
    } catch (err) {
      store.pushToast("Arm failed: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      this.set({ arming: false });
    }
  }

  // ── function details (lazy, cached per analysis generation) ──────────
  async loadFunction(id: string) {
    if (this.s.fnDetails[id]) return;
    this.set({ fnDetails: { ...this.s.fnDetails, [id]: "loading" } });
    try {
      const detail = await routesApi.fn(id);
      this.set({ fnDetails: { ...this.s.fnDetails, [id]: detail } });
    } catch {
      this.set({ fnDetails: { ...this.s.fnDetails, [id]: "error" } });
    }
  }
}

export const routesStore = new RoutesStore();

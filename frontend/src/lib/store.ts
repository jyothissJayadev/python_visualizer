/* store.ts — the Brain Terminal engine.

   A single mutable store that ingests trace events and control-plane
   messages, maintains the span / request graph, computes loop folding and
   row visibility, and exposes an immutable snapshot to React via
   useSyncExternalStore. This is a direct port of the imperative engine that
   lived in frontend/terminal.html. */

import type {
  Catalog,
  CatalogFunction,
  ClientOp,
  CodeStatusMessage,
  ConnectionStatus,
  IncomingMessage,
  LoopGroup,
  RequestData,
  SelectionAppliedMessage,
  SpanData,
  Template,
  TraceEvent,
  ValueMessage,
} from "../types";

const LOOP_COLLAPSE_THRESHOLD = 10;
const PERSIST_KEY = "brainTerminal.selection";

export type LlmTab = "raw" | "parsed";

export interface ToastState {
  id: number;
  msg: string;
}

/* ---- rows the stream renders ---- */

export type StreamRow =
  | { rowKind: "loop"; key: string; group: LoopGroup; depth: number; spanId: string }
  | { rowKind: "fn"; spanId: string; depth: number }
  | { rowKind: "error"; spanId: string; depth: number }
  | { rowKind: "llm"; spanId: string; depth: number }
  | { rowKind: "log"; key: string; event: TraceEvent };

export interface RequestView {
  id: string;
  startEvent: TraceEvent | null;
  endEvent: TraceEvent | null;
  rows: StreamRow[];
  visible: boolean;
  color: string;
}

export interface Snapshot {
  version: number;

  connection: ConnectionStatus;
  connectionLabel: string;
  codeInSync: boolean | null;
  brainFingerprint: string | null;

  catalog: Catalog;
  fnById: Map<string, CatalogFunction>;
  selectedFunctions: Set<string>;
  functionModes: Map<string, "deep">;
  appliedSelection: Set<string>;
  unresolvedIds: Set<string>;
  selectionDirty: boolean;
  catalogSearchQuery: string;
  collapsedPackages: Set<string>;
  templates: Template[];

  loopFold: boolean;
  selectedOnly: boolean;
  paused: boolean;
  filterQuery: string;
  autoScroll: boolean;
  unread: number;

  totalEvents: number;
  activeRequests: number;

  requests: RequestView[];
  spans: Map<string, SpanData>;
  requestMeta: Map<string, RequestData>;
  collapsedSpanIds: Set<string>;
  spanChildCounts: Map<string, number>;

  selectedSpanId: string | null;
  llmTab: LlmTab;

  toast: ToastState | null;
}

type Listener = () => void;

export class TerminalStore {
  private listeners = new Set<Listener>();
  private snapshot: Snapshot;
  private emitScheduled = false;
  private version = 0;
  private toastId = 0;
  private sender: ((op: ClientOp) => void) | null = null;

  /* raw state */
  private events: TraceEvent[] = [];
  // the collector replays its buffer on every (re)connect; rows are built from
  // `events`, so an event seen twice would render twice
  private seenEventKeys = new Set<string>();
  private spans = new Map<string, SpanData>();
  private requests = new Map<string, RequestData>();
  private reqOrder: string[] = [];
  private spanCounter = 0;

  private connection: ConnectionStatus = "connecting";
  private connectionLabel = "Connecting…";
  private codeInSync: boolean | null = null;
  private brainFingerprint: string | null = null;

  private catalog: Catalog = { groups: [] };
  private fnById = new Map<string, CatalogFunction>();
  private selectedFunctions = new Set<string>();
  private functionModes = new Map<string, "deep">();
  private appliedSelection = new Set<string>();
  // ids that were deep *at the moment Apply was pressed* — snapshotted so
  // toggling deep on an already-armed function is detected as "dirty".
  private appliedModes = new Set<string>();
  private unresolvedIds = new Set<string>();
  private catalogSearchQuery = "";
  private collapsedPackages = new Set<string>(); // holds "OPEN:<pkg>" once expanded
  private templates: Template[] = [];

  private loopFold = true;
  private selectedOnly = true;
  private paused = false;
  private pausedLen: number | null = null;
  private filterQuery = "";
  private autoScroll = true;
  private seenCount = 0;

  private loopGroups = new Map<string, LoopGroup>();
  private collapsedSpanIds = new Set<string>();
  private selectedSpanId: string | null = null;
  private llmTab: LlmTab = "parsed";
  private toast: ToastState | null = null;

  constructor() {
    this.loadPersistedSelection();
    this.snapshot = this.build();
  }

  /* ---------------------------------------------------------------- react glue */

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): Snapshot => this.snapshot;

  private scheduleEmit() {
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    const flush = () => {
      this.emitScheduled = false;
      this.snapshot = this.build();
      this.listeners.forEach((l) => l());
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }

  private emitNow() {
    this.snapshot = this.build();
    this.listeners.forEach((l) => l());
  }

  setSender(fn: (op: ClientOp) => void) {
    this.sender = fn;
  }

  send(op: ClientOp) {
    this.sender?.(op);
  }

  /* ---------------------------------------------------------------- connection */

  setConnection(status: ConnectionStatus, label: string) {
    this.connection = status;
    this.connectionLabel = label;
    this.emitNow();
  }

  onSocketOpen() {
    // Re-arm whatever was last applied so a reconnect / brain restart resumes
    // tracing the same functions without another click.
    if (this.appliedSelection.size > 0) {
      this.send({
        op: "apply_selection",
        selections: this.buildSelectionPayload(this.appliedSelection),
      });
    }
  }

  /* ---------------------------------------------------------------- ingest */

  handleMessage(raw: IncomingMessage) {
    const msg = raw as unknown as Record<string, unknown>;
    if (msg.kind === "value") {
      this.handleValue(raw as ValueMessage);
      return;
    }
    if (msg.kind === "selection_applied") {
      const m = raw as SelectionAppliedMessage;
      this.unresolvedIds = new Set((m.unresolved || []).map((u) => u.id));
      if (m.error) this.pushToast("Apply failed: " + m.error);
      else {
        const n = (m.armed || []).length;
        const u = (m.unresolved || []).length;
        this.pushToast(`Armed ${n} function(s)${u ? ` · ${u} unresolved` : ""}`);
      }
      this.emitNow();
      return;
    }
    if (msg.kind === "code_status") {
      const m = raw as CodeStatusMessage;
      this.codeInSync = m.in_sync;
      this.brainFingerprint = m.brain;
      this.emitNow();
      return;
    }
    if (msg.kind === "cleared") {
      // Another dashboard (or a reconnect after our own clear) wiped the
      // buffer — mirror it locally without echoing the op back.
      this.resetStreamState();
      this.emitNow();
      return;
    }
    this.ingestEvent(raw as TraceEvent);
  }

  private ingestEvent(ev: TraceEvent) {
    if (ev.seq != null) {
      const key = `${ev.request_id || ""}|${ev.span_id || ""}|${ev.kind}|${ev.seq}`;
      if (this.seenEventKeys.has(key)) return;
      this.seenEventKeys.add(key);
    }
    this.events.push(ev);
    const reqId = ev.request_id || "unscoped";

    let req = this.requests.get(reqId);
    if (!req) {
      req = { id: reqId, startEvent: null, endEvent: null, spanIds: [] };
      this.requests.set(reqId, req);
      this.reqOrder.push(reqId);
    }

    if (ev.span_id) {
      let span = this.spans.get(ev.span_id);
      if (!span) {
        span = {
          span_id: ev.span_id,
          request_id: reqId,
          parent_span_id: ev.parent_span_id || null,
          depth: ev.depth || 0,
          kind: ev.kind,
          order: this.spanCounter++,
          startEvent: null,
          endEvent: null,
          errorEvent: null,
          llmEvent: null,
        };
        this.spans.set(ev.span_id, span);
        req.spanIds.push(ev.span_id);
      }
      if (ev.kind === "fn.start") span.startEvent = ev;
      else if (ev.kind === "fn.end") span.endEvent = ev;
      else if (ev.kind === "fn.error") span.errorEvent = ev;
      else if (ev.kind === "llm.call") span.llmEvent = ev;
    }

    if (ev.kind === "request.start") req.startEvent = ev;
    else if (ev.kind === "request.end") req.endEvent = ev;

    if (!this.paused && this.autoScroll) this.seenCount = this.events.length;
    this.scheduleEmit();
  }

  private handleValue(msg: ValueMessage) {
    const span = this.spans.get(msg.span_id);
    if (!span) return;
    if (msg.error) {
      // keep the truncated preview; just say why the full value is gone
      this.pushToast(`Couldn't load full ${msg.field}: ${msg.error}`);
      return;
    }
    if (msg.field === "args" && span.startEvent?.data) {
      span.startEvent.data.args = msg.value;
      span.startEvent.data.args_truncated = false;
    } else if (msg.field === "result" && span.endEvent?.data) {
      span.endEvent.data.result = msg.value;
      span.endEvent.data.result_truncated = false;
    }
    if (this.selectedSpanId === msg.span_id)
      this.pushToast(`Loaded full untruncated ${msg.field} data`);
    this.emitNow();
  }

  /* ---------------------------------------------------------------- catalogue */

  async loadCatalog() {
    try {
      const resp = await fetch("/viewer/terminal/functions");
      if (resp.ok) {
        const data = await resp.json();
        if (data && data.groups) this.catalog = data;
      }
    } catch (e) {
      console.warn("Could not load function catalog:", e);
    }
    this.indexCatalog();
    this.emitNow();
  }

  async rescanCatalog() {
    try {
      const resp = await fetch("/viewer/terminal/rescan", { method: "POST" });
      if (resp.ok) {
        this.catalog = await resp.json();
        this.indexCatalog();
        this.pushToast("Catalogue re-scanned from source");
      }
    } catch {
      this.pushToast("Rescan failed");
    }
    this.emitNow();
  }

  private indexCatalog() {
    this.fnById = new Map();
    (this.catalog.groups || []).forEach((g) =>
      g.functions.forEach((f) => this.fnById.set(f.id, f)),
    );
  }

  /* ---------------------------------------------------------------- selection */

  private buildSelectionPayload(ids: Set<string>) {
    return Array.from(ids).map((id) => ({
      id,
      deep: this.functionModes.get(id) === "deep",
    }));
  }

  toggleFn(id: string, on: boolean) {
    if (on) this.selectedFunctions.add(id);
    else {
      this.selectedFunctions.delete(id);
      this.functionModes.delete(id);
    }
    this.persistSelection();
    this.emitNow();
  }

  setDeep(id: string, deep: boolean) {
    if (deep) this.functionModes.set(id, "deep");
    else this.functionModes.delete(id);
    this.persistSelection();
    this.emitNow();
  }

  clearSelection() {
    this.selectedFunctions.clear();
    this.functionModes.clear();
    this.persistSelection();
    this.emitNow();
  }

  applySelection() {
    const payload = this.buildSelectionPayload(this.selectedFunctions);
    this.send({ op: "apply_selection", selections: payload });
    this.appliedSelection = new Set(this.selectedFunctions);
    this.appliedModes = new Set(
      payload.filter((p) => p.deep).map((p) => p.id),
    );
    this.persistSelection();
    this.pushToast(
      payload.length
        ? `Applying ${payload.length} function(s)…`
        : "Cleared all instrumentation",
    );
    this.emitNow();
  }

  setCatalogSearch(q: string) {
    this.catalogSearchQuery = q;
    this.emitNow();
  }

  togglePackage(pkg: string) {
    const key = "OPEN:" + pkg;
    if (this.collapsedPackages.has(key)) this.collapsedPackages.delete(key);
    else this.collapsedPackages.add(key);
    this.emitNow();
  }

  /* ---------------------------------------------------------------- templates */

  async loadTemplates() {
    try {
      const resp = await fetch("/viewer/terminal/templates");
      if (resp.ok) {
        const data = await resp.json();
        this.templates = data.templates || [];
      }
    } catch (e) {
      console.warn("Could not load templates:", e);
    }
    this.emitNow();
  }

  private async submitTemplate(
    method: "POST" | "PUT",
    url: string,
    body: unknown,
    successMsg: string,
  ): Promise<boolean> {
    try {
      const resp = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        this.pushToast(`Couldn't save template: ${data.error || resp.statusText}`);
        return false;
      }
      await this.loadTemplates();
      this.pushToast(successMsg);
      return true;
    } catch {
      this.pushToast("Couldn't save template: network error");
      return false;
    }
  }

  /** Save the current (not-yet-applied) selection as a named template. */
  saveTemplate(name: string): Promise<boolean> {
    const functions = this.buildSelectionPayload(this.selectedFunctions);
    return this.submitTemplate(
      "POST",
      "/viewer/terminal/templates",
      { name, functions },
      `Saved template "${name}"`,
    );
  }

  /** Rename a template and/or replace its function list. Omit a field to leave it unchanged. */
  updateTemplate(
    id: string,
    changes: { name?: string; functions?: { id: string; deep: boolean }[] },
  ): Promise<boolean> {
    return this.submitTemplate(
      "PUT",
      `/viewer/terminal/templates/${encodeURIComponent(id)}`,
      changes,
      "Template updated",
    );
  }

  async deleteTemplate(id: string) {
    try {
      const resp = await fetch(`/viewer/terminal/templates/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        this.pushToast(`Couldn't delete template: ${data.error || resp.statusText}`);
        return;
      }
      await this.loadTemplates();
    } catch {
      this.pushToast("Couldn't delete template: network error");
    }
  }

  /** Arm every function in the template with its saved deep/shallow mode,
      replacing the current selection — reuses the existing apply pipeline
      (websocket op + selection_applied handling) rather than a separate path. */
  applyTemplate(id: string) {
    const template = this.templates.find((t) => t.id === id);
    if (!template) return;
    this.selectedFunctions = new Set(template.functions.map((f) => f.id));
    this.functionModes = new Map(
      template.functions.filter((f) => f.deep).map((f) => [f.id, "deep" as const]),
    );
    this.applySelection();
  }

  private persistSelection() {
    try {
      localStorage.setItem(
        PERSIST_KEY,
        JSON.stringify({
          selected: Array.from(this.selectedFunctions),
          deep: Array.from(this.functionModes.keys()),
          applied: Array.from(this.appliedSelection),
          appliedDeep: Array.from(this.appliedModes),
        }),
      );
    } catch {
      /* ignore */
    }
  }

  private loadPersistedSelection() {
    try {
      const raw = JSON.parse(localStorage.getItem(PERSIST_KEY) || "{}");
      (raw.selected || []).forEach((id: string) => this.selectedFunctions.add(id));
      (raw.deep || []).forEach((id: string) => this.functionModes.set(id, "deep"));
      (raw.applied || []).forEach((id: string) => this.appliedSelection.add(id));
      (raw.appliedDeep || []).forEach((id: string) => this.appliedModes.add(id));
    } catch {
      /* ignore */
    }
  }

  /* ---------------------------------------------------------------- stream ctl */

  toggleLoopFold() {
    this.loopFold = !this.loopFold;
    this.pushToast(
      this.loopFold
        ? `Loops folded — runs of ${LOOP_COLLAPSE_THRESHOLD}+ identical calls collapse to one row (click to expand)`
        : "Loops unfolded — every iteration shown",
    );
    this.emitNow();
  }

  toggleSelectedOnly() {
    this.selectedOnly = !this.selectedOnly;
    this.pushToast(
      this.selectedOnly
        ? "Focus mode: only armed calls and their nested calls — other requests and rows hidden"
        : "Showing every request, call and log line",
    );
    this.emitNow();
  }

  setFilterQuery(q: string) {
    this.filterQuery = q;
    this.emitNow();
  }

  togglePause() {
    this.paused = !this.paused;
    if (this.paused) {
      this.pausedLen = this.events.length;
    } else {
      this.pausedLen = null;
      this.seenCount = this.events.length;
    }
    this.pushToast(this.paused ? "Stream paused" : "Stream resumed");
    this.emitNow();
  }

  /** Wipe every stream-derived buffer. Shared by the Clear button and an
      incoming `cleared` broadcast. */
  private resetStreamState() {
    this.events = [];
    this.seenEventKeys.clear();
    this.spans.clear();
    this.requests.clear();
    this.reqOrder = [];
    this.loopGroups.clear();
    this.collapsedSpanIds.clear();
    this.spanCounter = 0;
    this.selectedSpanId = null;
    this.focusedIndex = -1;
    this.pausedLen = this.paused ? 0 : null;
    this.seenCount = 0;
  }

  clearStream() {
    this.resetStreamState();
    // Also drop the collector's replay buffer so a page refresh doesn't
    // re-hydrate what we just cleared, and clear other open dashboards.
    this.send({ op: "clear" });
    this.emitNow();
  }

  setAutoScroll(on: boolean) {
    if (this.autoScroll === on) return;
    this.autoScroll = on;
    if (on) this.seenCount = this.events.length;
    this.emitNow();
  }

  catchUp() {
    this.autoScroll = true;
    this.seenCount = this.events.length;
    this.emitNow();
  }

  /* ---------------------------------------------------------------- inspector */

  selectSpan(spanId: string | null) {
    this.selectedSpanId = spanId;
    this.emitNow();
  }

  closeInspector() {
    this.selectedSpanId = null;
    this.emitNow();
  }

  setLlmTab(tab: LlmTab) {
    this.llmTab = tab;
    this.emitNow();
  }

  loopToggleExpand(key: string) {
    const g = this.loopGroups.get(key);
    if (!g) return;
    g.expanded = !g.expanded;
    this.emitNow();
  }

  toggleSpanCollapse(spanId: string) {
    if (this.collapsedSpanIds.has(spanId)) {
      this.collapsedSpanIds.delete(spanId);
    } else {
      this.collapsedSpanIds.add(spanId);
    }
    this.emitNow();
  }

  collapseAllDeepSpans() {
    for (const span of this.spans.values()) {
      if (span.parent_span_id) {
        this.collapsedSpanIds.add(span.parent_span_id);
      }
    }
    this.pushToast("Collapsed all inner deep function calls");
    this.emitNow();
  }

  expandAllDeepSpans() {
    this.collapsedSpanIds.clear();
    this.pushToast("Expanded all inner deep function calls");
    this.emitNow();
  }

  private focusedIndex = -1;

  /** j / k navigation over the currently-visible selectable rows. */
  navigate(direction: 1 | -1) {
    const ids: string[] = [];
    for (const r of this.snapshot.requests) {
      if (!r.visible) continue;
      for (const row of r.rows) {
        if (row.rowKind === "log") continue;
        ids.push(row.spanId);
      }
    }
    if (ids.length === 0) return;
    if (this.focusedIndex === -1)
      this.focusedIndex = direction > 0 ? 0 : ids.length - 1;
    else
      this.focusedIndex = Math.max(
        0,
        Math.min(ids.length - 1, this.focusedIndex + direction),
      );
    this.selectedSpanId = ids[this.focusedIndex];
    this.emitNow();
  }

  loadFullValue(span: SpanData, field: "args" | "result") {
    this.send({
      op: "get_value",
      request_id: span.request_id,
      span_id: span.span_id,
      field,
    });
  }

  /* ---------------------------------------------------------------- toast */

  pushToast(msg: string) {
    this.toast = { id: ++this.toastId, msg };
    this.emitNow();
  }

  dismissToast(id: number) {
    if (this.toast?.id === id) {
      this.toast = null;
      this.emitNow();
    }
  }

  /* ---------------------------------------------------------------- derive */

  private eventFilterMatch(ev: TraceEvent): boolean {
    if (
      ev.kind === "log" &&
      this.selectedOnly &&
      this.appliedSelection.size > 0 &&
      !this.reqSelectedCall(ev.request_id || "unscoped")
    ) {
      return false;
    }
    const q = this.filterQuery.toLowerCase().trim();
    if (!q) return true;
    if (ev.request_id?.toLowerCase().includes(q)) return true;
    if (ev.span_id?.toLowerCase().includes(q)) return true;
    if (ev.kind?.toLowerCase().includes(q)) return true;
    const d = ev.data;
    if (d) {
      if (d.name?.toLowerCase().includes(q)) return true;
      if (d.qualname?.toLowerCase().includes(q)) return true;
      if (d.path?.toLowerCase().includes(q)) return true;
      if (d.model?.toLowerCase().includes(q)) return true;
      if (d.line?.toLowerCase().includes(q)) return true;
      if (d.message?.toLowerCase().includes(q)) return true;
    }
    return false;
  }

  private reqSelectedCallCache = new Map<string, boolean>();
  private reqSelectedCall(reqId: string): boolean {
    return this.reqSelectedCallCache.get(reqId) === true;
  }

  private spanLabel(sp: SpanData): string | null {
    return (
      sp.startEvent?.data?.name ||
      sp.errorEvent?.data?.name ||
      sp.endEvent?.data?.name ||
      null
    );
  }

  private build(): Snapshot {
    this.version++;
    const displayLen =
      this.paused && this.pausedLen != null ? this.pausedLen : this.events.length;
    const displayEvents = this.events.slice(0, displayLen);

    // reqSelectedCall map
    this.reqSelectedCallCache = new Map();
    for (const ev of displayEvents) {
      if (
        ev.kind === "fn.start" &&
        ev.data?.name &&
        this.appliedSelection.has(ev.data.name)
      ) {
        this.reqSelectedCallCache.set(ev.request_id || "unscoped", true);
      }
    }

    // ---- parent-child span hierarchy & collapse -----------------------
    const childrenByParent = new Map<string, string[]>();
    const spanChildCounts = new Map<string, number>();

    for (const span of this.spans.values()) {
      if (span.parent_span_id) {
        const list = childrenByParent.get(span.parent_span_id) || [];
        list.push(span.span_id);
        childrenByParent.set(span.parent_span_id, list);
      }
    }

    const getAllDescendants = (rootId: string): string[] => {
      const desc: string[] = [];
      const stack = [...(childrenByParent.get(rootId) || [])];
      while (stack.length > 0) {
        const cId = stack.pop()!;
        desc.push(cId);
        const sub = childrenByParent.get(cId);
        if (sub) stack.push(...sub);
      }
      return desc;
    };

    for (const spanId of this.spans.keys()) {
      const desc = getAllDescendants(spanId);
      if (desc.length > 0) {
        spanChildCounts.set(spanId, desc.length);
      }
    }

    const hiddenByParentCollapse = new Set<string>();
    for (const parentId of this.collapsedSpanIds) {
      const desc = getAllDescendants(parentId);
      desc.forEach((d) => hiddenByParentCollapse.add(d));
    }

    // ---- loop folding -------------------------------------------------
    // A "loop" is a run of LOOP_COLLAPSE_THRESHOLD+ consecutive sibling
    // spans that share a label. Collapsed, it is a single summary row and
    // every member (and its subtree) is hidden. Expanded, all members
    // render inline in order, each with its own args / return preview, and
    // a nested run inside an iteration folds into its own sub-row.
    const collapsedMembers = new Set<string>(); // member rows a collapsed group swallows
    const hiddenByLoop = new Set<string>(); // spans under a *collapsed* member (incl. nested group rows)
    const firstMemberToGroup = new Map<string, LoopGroup>();
    const liveKeys = new Set<string>();

    if (this.loopFold) {
      for (const reqId of this.reqOrder) {
        const req = this.requests.get(reqId);
        if (!req) continue;
        const reqChildrenByParent = new Map<string, SpanData[]>();
        for (const sid of req.spanIds) {
          const sp = this.spans.get(sid);
          if (!sp) continue;
          const key = sp.parent_span_id || "__root__";
          if (!reqChildrenByParent.has(key)) reqChildrenByParent.set(key, []);
          reqChildrenByParent.get(key)!.push(sp);
        }
        const descendantsOf = (rootId: string): string[] => {
          const out: string[] = [];
          const stack = [...(reqChildrenByParent.get(rootId) || [])];
          while (stack.length) {
            const c = stack.pop()!;
            out.push(c.span_id);
            const gk = reqChildrenByParent.get(c.span_id);
            if (gk) stack.push(...gk);
          }
          return out;
        };
        reqChildrenByParent.forEach((kids) => {
          kids.sort((a, b) => a.order - b.order);
          let i = 0;
          while (i < kids.length) {
            const label = this.spanLabel(kids[i]);
            let j = i + 1;
            while (j < kids.length && this.spanLabel(kids[j]) === label) j++;
            if (label && j - i >= LOOP_COLLAPSE_THRESHOLD) {
              const members = kids.slice(i, j);
              const key = `${reqId}|${members[0].parent_span_id || "root"}|${label}|${members[0].span_id}`;
              liveKeys.add(key);
              let g = this.loopGroups.get(key);
              if (!g) {
                g = { key, reqId, memberSpanIds: [], expanded: false };
                this.loopGroups.set(key, g);
              }
              g.memberSpanIds = members.map((m) => m.span_id);
              firstMemberToGroup.set(members[0].span_id, g);

              if (!g.expanded) {
                members.forEach((m) => {
                  collapsedMembers.add(m.span_id);
                  descendantsOf(m.span_id).forEach((s) => hiddenByLoop.add(s));
                });
              }
            }
            i = j;
          }
        });
      }
    }
    // drop stale groups
    for (const key of [...this.loopGroups.keys()])
      if (!liveKeys.has(key)) this.loopGroups.delete(key);

    // ---- "Selected only": keep just the armed calls and their subtrees --
    const gate = this.selectedOnly && this.appliedSelection.size > 0;
    const inSelectedSubtree = new Set<string>();
    if (gate) {
      const ordered = [...this.spans.values()].sort((a, b) => a.order - b.order);
      for (const sp of ordered) {
        const label = this.spanLabel(sp);
        if (
          (label != null && this.appliedSelection.has(label)) ||
          (sp.parent_span_id != null && inSelectedSubtree.has(sp.parent_span_id))
        ) {
          inSelectedSubtree.add(sp.span_id);
        }
      }
    }

    // rows, per request, in arrival order
    const requests: RequestView[] = [];
    let activeRequests = 0;
    const spanGated = (id: string) => gate && !inSelectedSubtree.has(id);

    for (const reqId of this.reqOrder) {
      const req = this.requests.get(reqId)!;
      if (req.startEvent && !req.endEvent) activeRequests++;

      const rows: StreamRow[] = [];
      for (const ev of displayEvents) {
        if ((ev.request_id || "unscoped") !== reqId) continue;
        const depth = ev.depth || 0;

        if (ev.kind === "fn.start" && ev.span_id) {
          if (hiddenByParentCollapse.has(ev.span_id)) continue;
          const grp = firstMemberToGroup.get(ev.span_id);
          if (grp && !hiddenByLoop.has(ev.span_id) && !spanGated(ev.span_id)) {
            rows.push({
              rowKind: "loop",
              key: grp.key,
              group: grp,
              depth,
              spanId: ev.span_id,
            });
          }
          if (hiddenByLoop.has(ev.span_id) || collapsedMembers.has(ev.span_id))
            continue;
          if (spanGated(ev.span_id)) continue;
          if (!this.eventFilterMatch(ev)) continue;
          rows.push({ rowKind: "fn", spanId: ev.span_id, depth });
        } else if (ev.kind === "fn.error" && ev.span_id) {
          if (hiddenByParentCollapse.has(ev.span_id)) continue;
          if (hiddenByLoop.has(ev.span_id) || collapsedMembers.has(ev.span_id))
            continue;
          if (spanGated(ev.span_id)) continue;
          if (!this.eventFilterMatch(ev)) continue;
          rows.push({ rowKind: "error", spanId: ev.span_id, depth });
        } else if (ev.kind === "llm.call" && ev.span_id) {
          if (hiddenByParentCollapse.has(ev.span_id)) continue;
          if (hiddenByLoop.has(ev.span_id) || collapsedMembers.has(ev.span_id))
            continue;
          if (spanGated(ev.span_id)) continue;
          if (!this.eventFilterMatch(ev)) continue;
          rows.push({ rowKind: "llm", spanId: ev.span_id, depth });
        } else if (ev.kind === "log") {
          if (!this.eventFilterMatch(ev)) continue;
          rows.push({
            rowKind: "log",
            key: `log-${ev.seq ?? Math.random()}`,
            event: ev,
          });
        }
      }

      const visible = !gate || this.reqSelectedCall(reqId) === true;
      requests.push({
        id: reqId,
        startEvent: req.startEvent,
        endEvent: req.endEvent,
        rows,
        visible,
        color: deterministicColor(reqId),
      });
    }

    const unread = Math.max(0, this.events.length - this.seenCount);

    // selectionDirty
    const cur =
      Array.from(this.selectedFunctions).sort().join("|") +
      "::" +
      Array.from(this.functionModes.entries())
        .filter(([, m]) => m === "deep")
        .map(([k]) => k)
        .sort()
        .join("|");
    const applied =
      Array.from(this.appliedSelection).sort().join("|") +
      "::" +
      Array.from(this.appliedModes).sort().join("|");

    return {
      version: this.version,
      connection: this.connection,
      connectionLabel: this.connectionLabel,
      codeInSync: this.codeInSync,
      brainFingerprint: this.brainFingerprint,
      catalog: this.catalog,
      fnById: this.fnById,
      selectedFunctions: new Set(this.selectedFunctions),
      functionModes: new Map(this.functionModes),
      appliedSelection: new Set(this.appliedSelection),
      unresolvedIds: new Set(this.unresolvedIds),
      selectionDirty: cur !== applied,
      catalogSearchQuery: this.catalogSearchQuery,
      collapsedPackages: new Set(this.collapsedPackages),
      templates: this.templates,
      loopFold: this.loopFold,
      selectedOnly: this.selectedOnly,
      paused: this.paused,
      filterQuery: this.filterQuery,
      autoScroll: this.autoScroll,
      unread,
      totalEvents: this.events.length,
      activeRequests,
      requests,
      spans: this.spans,
      requestMeta: this.requests,
      collapsedSpanIds: new Set(this.collapsedSpanIds),
      spanChildCounts,
      selectedSpanId: this.selectedSpanId,
      llmTab: this.llmTab,
      toast: this.toast,
    };
  }
}

function deterministicColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++)
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const colors = [
    "#4ade80",
    "#3ce7ff",
    "#7dffa8",
    "#2fae67",
    "#c58bff",
    "#ffcf4d",
    "#35d0a0",
  ];
  return colors[Math.abs(hash) % colors.length];
}

export const store = new TerminalStore();

import {
  BRAIN_DATABASE_SCHEMA,
  type DatabaseRelationship,
  type DatabaseSchema,
  type DatabaseTable,
  type DatabaseType,
  type RelationType,
  type TableDomain,
} from "./databaseEngine";
import { fetchCodeTables, mergeCodeIntoSchema, type SchemaAudit } from "./databaseCode";
import { store } from "./store";

export type DatabaseFilter = "all" | DatabaseType;
export type DomainFilter = "all" | TableDomain;
export type RelationFilter = "all" | RelationType;
export type DatabaseViewMode = "canvas" | "matrix";
export type DrawerTab = "schema" | "indexes" | "functions" | "endpoints" | "relations";

export interface DatabaseSnapshot {
  schema: DatabaseSchema;
  loading: boolean;
  rescanning: boolean;
  lastRescannedAt: string | null;
  selectedTableId: string | null;
  searchQuery: string;
  databaseFilter: DatabaseFilter;
  domainFilter: DomainFilter;
  relationFilter: RelationFilter;
  viewMode: DatabaseViewMode;
  hoveredTableId: string | null;
  hoveredRelationId: string | null;
  activeDrawerTab: DrawerTab;
  zoomLevel: number;
  enabledTableIds: Set<string>;
  focusConnectedOnly: boolean;
  /** the code analysis behind the function / endpoint links */
  codeState: "idle" | "loading" | "ready" | "error";
  codeError: string | null;
  codeAudit: SchemaAudit | null;
}

class DatabaseStore {
  private snapshot: DatabaseSnapshot = {
    schema: BRAIN_DATABASE_SCHEMA,
    loading: false,
    rescanning: false,
    lastRescannedAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    selectedTableId: "mongo:quotation_quotations",
    searchQuery: "",
    databaseFilter: "all",
    domainFilter: "all",
    relationFilter: "all",
    viewMode: "canvas",
    hoveredTableId: null,
    hoveredRelationId: null,
    activeDrawerTab: "schema",
    zoomLevel: 1,
    enabledTableIds: new Set(BRAIN_DATABASE_SCHEMA.tables.map((t) => t.id)),
    focusConnectedOnly: false,
    codeState: "idle",
    codeError: null,
    codeAudit: null,
  };

  private listeners = new Set<() => void>();
  private codeRetries = 0;

  constructor() {
    void this.loadCode();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): DatabaseSnapshot => {
    return this.snapshot;
  };

  private emit() {
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.error("DatabaseStore listener error:", err);
      }
    }
  }

  select(id: string | null) {
    if (this.snapshot.selectedTableId === id) return;
    this.snapshot = { ...this.snapshot, selectedTableId: id };
    this.emit();
  }

  setSearchQuery(searchQuery: string) {
    this.snapshot = { ...this.snapshot, searchQuery };
    this.emit();
  }

  setDatabaseFilter(databaseFilter: DatabaseFilter) {
    this.snapshot = { ...this.snapshot, databaseFilter };
    this.emit();
  }

  setDomainFilter(domainFilter: DomainFilter) {
    this.snapshot = { ...this.snapshot, domainFilter };
    this.emit();
  }

  setRelationFilter(relationFilter: RelationFilter) {
    this.snapshot = { ...this.snapshot, relationFilter };
    this.emit();
  }

  setViewMode(viewMode: DatabaseViewMode) {
    this.snapshot = { ...this.snapshot, viewMode };
    this.emit();
  }

  setHoveredTable(_id: string | null) {
    // Disabled hover dimming/state changes per user requirement
  }

  setHoveredRelation(_id: string | null) {
    // Disabled hover dimming/state changes per user requirement
  }

  setActiveDrawerTab(activeDrawerTab: DrawerTab) {
    this.snapshot = { ...this.snapshot, activeDrawerTab };
    this.emit();
  }

  setZoomLevel(zoomLevel: number) {
    const clamped = Math.min(2.0, Math.max(0.4, zoomLevel));
    this.snapshot = { ...this.snapshot, zoomLevel: clamped };
    this.emit();
  }

  // Checklist for enabling/disabling tables in view mode
  toggleTableEnabled(tableId: string) {
    const next = new Set(this.snapshot.enabledTableIds);
    if (next.has(tableId)) {
      next.delete(tableId);
    } else {
      next.add(tableId);
    }
    this.snapshot = { ...this.snapshot, enabledTableIds: next };
    this.emit();
  }

  enableAllTables() {
    const allIds = new Set(this.snapshot.schema.tables.map((t) => t.id));
    this.snapshot = { ...this.snapshot, enabledTableIds: allIds };
    this.emit();
  }

  disableAllTables() {
    this.snapshot = { ...this.snapshot, enabledTableIds: new Set() };
    this.emit();
  }

  isTableEnabled(tableId: string): boolean {
    return this.snapshot.enabledTableIds.has(tableId);
  }

  /** Read brain's code: which tables exist, what uses them, their inferred
      fields. Merged with the documented schema (see databaseCode.ts). */
  async loadCode(): Promise<boolean> {
    this.snapshot = { ...this.snapshot, codeState: "loading", codeError: null };
    this.emit();
    try {
      const { tables, relationships, generation } = await fetchCodeTables();
      const { schema, audit } = mergeCodeIntoSchema(tables, relationships, generation);
      const prev = this.snapshot;
      const ids = new Set(schema.tables.map((t) => t.id));
      const before = new Set(prev.schema.tables.map((t) => t.id));
      const enabled =
        prev.codeAudit === null
          ? ids
          : new Set([...ids].filter((id) => prev.enabledTableIds.has(id) || !before.has(id)));
      this.codeRetries = 0;
      this.snapshot = { ...prev, schema, enabledTableIds: enabled, codeState: "ready", codeError: null, codeAudit: audit };
      this.emit();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.snapshot = { ...this.snapshot, codeState: "error", codeError: message };
      this.emit();
      if (this.codeRetries++ < 20) setTimeout(() => void this.loadCode(), 2500); // backend / analysis not up yet
      return false;
    }
  }

  async rescan(): Promise<void> {
    if (this.snapshot.rescanning) return;
    this.snapshot = { ...this.snapshot, rescanning: true };
    this.emit();

    try {
      if (await this.loadCode()) {
        this.snapshot = {
          ...this.snapshot,
          rescanning: false,
          lastRescannedAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        };
        store.pushToast(`Read ${this.snapshot.schema.tables.length} tables from brain's code`);
        this.emit();
        return;
      }
      const res = await fetch("/api/database/schema", { method: "GET" }).catch(() => null);
      if (res && res.ok) {
        const data = (await res.json()) as DatabaseSchema;
        if (data && data.tables?.length) {
          const allIds = new Set(data.tables.map((t) => t.id));
          this.snapshot = {
            ...this.snapshot,
            schema: data,
            enabledTableIds: allIds,
            rescanning: false,
            lastRescannedAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
          };
          store.pushToast(`Scanned ${data.tables.length} tables & graph models`);
          this.emit();
          return;
        }
      }

      await new Promise((r) => setTimeout(r, 600));

      this.snapshot = {
        ...this.snapshot,
        schema: { ...BRAIN_DATABASE_SCHEMA },
        enabledTableIds: new Set(BRAIN_DATABASE_SCHEMA.tables.map((t) => t.id)),
        rescanning: false,
        lastRescannedAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      };
      store.pushToast("Rescanned deterministic Brain DB schema (MongoDB & Neo4j)");
      this.emit();
    } catch {
      this.snapshot = { ...this.snapshot, rescanning: false };
      this.emit();
    }
  }

  getSelectedTable(): DatabaseTable | null {
    if (!this.snapshot.selectedTableId) return null;
    return (
      this.snapshot.schema.tables.find((t) => t.id === this.snapshot.selectedTableId) ?? null
    );
  }

  setFocusConnectedOnly(focusConnectedOnly: boolean) {
    if (this.snapshot.focusConnectedOnly === focusConnectedOnly) return;
    this.snapshot = { ...this.snapshot, focusConnectedOnly };
    this.emit();
  }

  toggleFocusConnectedOnly() {
    this.setFocusConnectedOnly(!this.snapshot.focusConnectedOnly);
  }

  /**
   * Returns the IDs of all tables directly connected to tableId via incoming or outgoing relationships.
   */
  getConnectedTableIds(tableId: string): Set<string> {
    const { schema } = this.snapshot;
    const connected = new Set<string>();
    for (const rel of schema.relationships) {
      if (rel.fromTableId === tableId) {
        connected.add(rel.toTableId);
      }
      if (rel.toTableId === tableId) {
        connected.add(rel.fromTableId);
      }
    }
    return connected;
  }

  /**
   * Returns the full table models directly connected to tableId.
   */
  getConnectedTables(tableId: string): DatabaseTable[] {
    const ids = this.getConnectedTableIds(tableId);
    return this.snapshot.schema.tables.filter((t) => ids.has(t.id));
  }

  /**
   * Tables that match search query and domain/database filters.
   */
  getFilteredTables(): DatabaseTable[] {
    const { schema, databaseFilter, domainFilter, searchQuery } = this.snapshot;
    const q = searchQuery.trim().toLowerCase();

    return schema.tables.filter((t) => {
      if (databaseFilter !== "all" && t.database !== databaseFilter) return false;
      if (domainFilter !== "all" && t.domain !== domainFilter) return false;
      if (q) {
        const matchesName = t.name.toLowerCase().includes(q);
        const matchesDoc = t.doc.toLowerCase().includes(q);
        const matchesFields = t.fields.some((f) => f.name.toLowerCase().includes(q) || f.type.toLowerCase().includes(q));
        const matchesFn = t.functions.some((fn) => fn.name.toLowerCase().includes(q) || fn.package.toLowerCase().includes(q));
        const matchesEp = t.endpoints.some((ep) => ep.path.toLowerCase().includes(q) || ep.method.toLowerCase().includes(q));
        if (!matchesName && !matchesDoc && !matchesFields && !matchesFn && !matchesEp) {
          return false;
        }
      }
      return true;
    });
  }

  /**
   * Tables that are visible in the diagram / view mode.
   * If focusConnectedOnly is active and a table is selected, only the selected table
   * and all tables directly connected to it are returned!
   */
  getVisibleTables(): DatabaseTable[] {
    const { schema, selectedTableId, focusConnectedOnly } = this.snapshot;

    if (focusConnectedOnly && selectedTableId) {
      const selected = schema.tables.find((t) => t.id === selectedTableId);
      if (!selected) return [];

      const connectedIds = this.getConnectedTableIds(selectedTableId);
      connectedIds.add(selectedTableId);

      // Return selected table first, then its connected neighbors
      return schema.tables.filter((t) => connectedIds.has(t.id));
    }

    const filtered = this.getFilteredTables();
    return filtered.filter((t) => this.snapshot.enabledTableIds.has(t.id));
  }

  /**
   * Relationships where BOTH the fromTable and toTable are visible/enabled in view mode.
   */
  getFilteredRelationships(): DatabaseRelationship[] {
    const { schema, relationFilter } = this.snapshot;
    const visibleTableIds = new Set(this.getVisibleTables().map((t) => t.id));

    return schema.relationships.filter((rel) => {
      if (relationFilter !== "all" && rel.type !== relationFilter) return false;

      // Both source and target must be enabled/visible in view mode
      return visibleTableIds.has(rel.fromTableId) && visibleTableIds.has(rel.toTableId);
    });
  }
}

export const databaseStore = new DatabaseStore();

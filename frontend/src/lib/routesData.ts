/* routesData.ts — joins the database tables the code analysis found with the
   documented schema of the Database view (lib/databaseEngine.ts), so an
   endpoint's Data tab can show fields / relationships where they are known
   and still show tables the schema does not describe. */

import { BRAIN_DATABASE_SCHEMA, type DatabaseRelationship, type DatabaseTable, type TableDomain } from "./databaseEngine";
import type { DataOp, TableUsage } from "./routesApi";

const SCHEMA_BY_ID = new Map(BRAIN_DATABASE_SCHEMA.tables.map((t) => [t.id, t]));

export const OP_LABEL: Record<DataOp, string> = {
  read: "read",
  write: "write",
  upsert: "upsert",
  delete: "delete",
  unknown: "unknown",
};

export const isRelationship = (id: string) => id.startsWith("neo4j-rel:");

/** "mongo:quotation_rows" -> "quotation_rows"; "neo4j-rel:IS_A" -> "[IS_A]" */
export function tableLabel(id: string): string {
  return isRelationship(id) ? `[${shortTable(id)}]` : shortTable(id);
}

/** "mongo:quotation_rows" -> "quotation_rows" */
export function shortTable(id: string): string {
  return id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
}

export function isDocumented(id: string): boolean {
  return SCHEMA_BY_ID.has(id);
}

export function guessDomain(name: string): TableDomain {
  if (name.startsWith("quotation_")) return "quotation";
  if (name.startsWith("execution_")) return "execution";
  if (/^(ChatSession|ProjectContext|CatalogItem)$/.test(name)) return "chat";
  return "shared";
}

/** The table as the Database view's card expects it: the documented schema
    entry when there is one, otherwise a bare placeholder. Either way the
    `functions` list is replaced by what *this endpoint* does to the table. */
export function displayTable(usage: TableUsage): DatabaseTable {
  const known = SCHEMA_BY_ID.get(usage.table);
  const functions = usage.functions.map((f) => ({
    fnId: f.function_id ?? f.name,
    name: f.name,
    package: "",
    op: f.op as "read" | "write" | "upsert" | "delete",
  }));
  // endpoints: [] — the card should describe this endpoint, not every endpoint in the schema
  if (known) return { ...known, functions, endpoints: [] };
  const neo = usage.database === "neo4j";
  return {
    id: usage.table,
    database: usage.database,
    name: usage.kind === "relationship" ? `[${usage.name}]` : usage.name,
    domain: guessDomain(usage.name),
    type: neo ? "graph_node" : "collection",
    doc: usage.kind === "relationship" ? "Neo4j relationship type — an edge between two nodes." : "",
    fields: [],
    indexes: [],
    functions,
    endpoints: [],
  };
}

/** Documented relationships between two tables that are both in `ids`. */
export function relationsAmong(ids: Set<string>, all: DatabaseRelationship[]): DatabaseRelationship[] {
  return all.filter((r) => ids.has(r.fromTableId) && ids.has(r.toTableId));
}

/** Every documented relationship that touches `id`. */
export function relationsOf(id: string, all: DatabaseRelationship[]): DatabaseRelationship[] {
  return all.filter((r) => r.fromTableId === id || r.toTableId === id);
}

export function openInDatabaseView(id: string) {
  window.location.hash = "#/database?" + new URLSearchParams({ table: id }).toString();
}

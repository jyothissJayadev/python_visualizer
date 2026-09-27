/* databaseCode.ts — the Database view, backed by what brain's code really does.

   The documented schema (databaseEngine.ts) is kept for what only a person can
   write down: field descriptions, indexes and relationships. Everything that
   can be *derived* comes from the code analysis instead (GET
   /viewer/routes/database): which tables exist, which functions read / write
   them, which endpoints reach them (with the real call chain), and — where no
   one documented them — their fields, inferred from models and from what the
   code writes and queries. Hand-written function / endpoint lists were mostly
   invented (59 of 65 function ids did not exist), so they are not used. */

import {
  BRAIN_DATABASE_SCHEMA,
  type DatabaseEndpointLineage,
  type DatabaseField,
  type DatabaseIndex,
  type DatabaseFunctionUsage,
  type DatabaseRelationship,
  type DatabaseSchema,
  type DatabaseTable,
} from "./databaseEngine";
import { guessDomain } from "./routesData";

export interface CodeField {
  name: string;
  type: string;
  source: "model" | "write" | "query" | "cypher";
}

export interface CodeFunction {
  function_id: string | null;
  name: string;
  op: "read" | "write" | "upsert" | "delete";
  count: number;
  uncertain: boolean;
  module: string | null;
  doc: string | null;
}

export interface CodeEndpoint {
  endpoint_id: string;
  method: string;
  path: string;
  summary: string | null;
  call_chain: string[];
  ops: string[];
}

/** An index / constraint the code creates. */
export interface CodeIndex {
  name: string;
  keys: string[]; // a leading "-" marks descending
  unique: boolean;
  kind: "index" | "constraint" | "ttl";
  source: string; // file:line
}

export interface CodeTable {
  table: string; // "mongo:quotation_rows" | "mongo:ChatSession" | "neo4j:KNode" | "neo4j-rel:IS_A"
  database: "mongodb" | "neo4j";
  kind: "collection" | "label" | "relationship";
  name: string;
  ops: Record<string, number>;
  uncertain: boolean;
  fields: CodeField[];
  indexes: CodeIndex[];
  functions: CodeFunction[];
  endpoints: CodeEndpoint[];
}

/** A connection between two tables, derived from the code. */
export interface CodeRelationship {
  id: string;
  from: string;
  to: string;
  type: "mongo_fk" | "neo4j_edge" | "cross_database";
  label: string;
  confidence: "exact" | "inferred";
  uncertain: boolean;
  fields: string[];
  evidence: { function_id: string | null; name: string }[];
}

/** How the documented schema and the code compare. */
export interface SchemaAudit {
  codeTables: number;
  documentedTables: number;
  /** documented tables that no function in the code touches */
  documentedUnused: { id: string; name: string }[];
  /** tables the code touches that the documented schema does not describe */
  undocumented: { id: string; name: string; fields: number }[];
  /** tables whose field list is (partly) inferred rather than documented */
  inferredFieldTables: number;
  /** documented fields the code does not have: `exact` when a model class is the authority, otherwise
      only "not seen in anything the code writes or queries" */
  staleFields: { table: string; name: string; exact: boolean }[];
  /** connections drawn between tables: exact (stated by the code) and inferred (from field names) */
  exactRelations: number;
  inferredRelations: number;
  generation: number;
}

export async function fetchCodeTables(): Promise<{ tables: CodeTable[]; relationships: CodeRelationship[]; generation: number }> {
  const res = await fetch("/viewer/routes/database");
  if (!res.ok) throw new Error(res.status === 503 ? "the analysis is still running" : `HTTP ${res.status}`);
  return (await res.json()) as { tables: CodeTable[]; relationships: CodeRelationship[]; generation: number };
}

const SOURCE_NOTE: Record<CodeField["source"], string> = {
  model: "from the model class",
  write: "written by the code",
  query: "queried by the code",
  cypher: "used in a Cypher query",
};

function inferredField(f: CodeField): DatabaseField {
  return { name: f.name, type: f.type === "any" ? "unknown" : f.type, doc: `Inferred — ${SOURCE_NOTE[f.source]}` };
}

function indexesOf(t: CodeTable): DatabaseIndex[] {
  return t.indexes.map((i) => ({ name: i.name, keys: i.keys, unique: i.unique, type: i.kind }));
}

function functionsOf(t: CodeTable): DatabaseFunctionUsage[] {
  return t.functions.map((f) => ({
    fnId: f.function_id ?? f.name,
    name: f.name,
    package: f.module ?? "",
    op: f.op,
    description: f.doc ?? undefined,
  }));
}

function endpointsOf(t: CodeTable): DatabaseEndpointLineage[] {
  return t.endpoints.map((e) => ({
    endpointId: e.endpoint_id,
    method: e.method as DatabaseEndpointLineage["method"],
    path: e.path,
    summary: e.summary ?? undefined,
    callChain: e.call_chain,
  }));
}

const PLACEHOLDER_DOC: Record<CodeTable["kind"], string> = {
  collection: "MongoDB collection found in the code — not described in the documented schema. Fields are inferred from what the code writes and queries.",
  label: "Neo4j node label found in the code — not described in the documented schema. Properties are inferred from the Cypher that uses it.",
  relationship: "Neo4j relationship type — an edge between two nodes. Properties are inferred from the Cypher that uses it.",
};

// grid for tables with no hand-placed position
const GRID_COLS = 5;
const GRID_X = 310;
const GRID_Y = 300;

export function mergeCodeIntoSchema(
  code: CodeTable[],
  derived: CodeRelationship[],
  generation: number,
): { schema: DatabaseSchema; audit: SchemaAudit } {
  const base = BRAIN_DATABASE_SCHEMA;
  const byId = new Map(code.map((c) => [c.table, c]));
  const documentedIds = new Set(base.tables.map((t) => t.id));

  // documented tables: keep the documentation, take the links (and any extra fields) from the code
  const tables: DatabaseTable[] = base.tables.map((t) => {
    const c = byId.get(t.id);
    if (!c) return { ...t, functions: [], endpoints: [], indexes: [] };
    const known = new Set(t.fields.map((f) => f.name));
    const extra = c.fields.filter((f) => !known.has(f.name)).map(inferredField);
    // indexes come from the code (create_index / CREATE INDEX ...), never from the documentation
    return { ...t, fields: [...t.fields, ...extra], indexes: indexesOf(c), functions: functionsOf(c), endpoints: endpointsOf(c) };
  });

  // tables only the code knows about
  let maxY = 0;
  for (const t of base.tables) maxY = Math.max(maxY, (t.y ?? 0) + 280);
  const order = (c: CodeTable) => `${c.database}|${c.kind === "relationship" ? "z" : "a"}|${guessDomain(c.name)}|${c.name}`;
  const fresh = code.filter((c) => !documentedIds.has(c.table)).sort((a, b) => order(a).localeCompare(order(b)));
  fresh.forEach((c, i) => {
    const fields = c.fields.map(inferredField);
    if (c.database === "mongodb" && !fields.some((f) => f.name === "_id")) {
      fields.unshift({ name: "_id", type: "ObjectId", isPrimary: true, doc: "MongoDB BSON ObjectId" });
    }
    tables.push({
      id: c.table,
      database: c.database,
      name: c.kind === "relationship" ? `[${c.name}]` : c.name,
      domain: guessDomain(c.name),
      type: c.database === "neo4j" ? "graph_node" : "collection",
      doc: PLACEHOLDER_DOC[c.kind],
      fields,
      indexes: indexesOf(c),
      functions: functionsOf(c),
      endpoints: endpointsOf(c),
      x: 60 + (i % GRID_COLS) * GRID_X,
      y: maxY + 90 + Math.floor(i / GRID_COLS) * GRID_Y,
    });
  });

  const count = (db: "mongodb" | "neo4j") => tables.filter((t) => t.database === db).length;
  // connections come from the code only (the hand-written list is gone): exact Neo4j edges, and
  // Mongo references inferred from field names. Both ends must be a table we list.
  const ids = new Set(tables.map((t) => t.id));
  const relationships: DatabaseRelationship[] = derived
    .filter((r) => ids.has(r.from) && ids.has(r.to))
    .map((r) => ({
      id: r.id,
      fromTableId: r.from,
      toTableId: r.to,
      fromField: r.type === "neo4j_edge" ? undefined : r.fields[0],
      type: r.type,
      label: r.type === "neo4j_edge" && r.uncertain ? `${r.label}?` : r.label,
      confidence: r.confidence,
      uncertain: r.uncertain,
      evidence: r.evidence,
      doc:
        r.confidence === "exact"
          ? `Neo4j edge ${r.label} — stated by the Cypher in ${r.evidence.map((e) => e.name).join(", ") || "the code"}${r.uncertain ? " (the label is chosen at runtime)" : ""}.`
          : `Inferred from the field name${r.fields.length > 1 ? "s" : ""} ${r.fields.join(", ")} — a name-based guess, not stated by the code.`,
    }));

  // A Neo4j edge runs between two labels (Concept -[IS_A]-> Concept). The relationship-type card
  // (`[IS_A]`) sits in that edge, so connect it to the labels it joins — otherwise it has no links.
  const membership: DatabaseRelationship[] = derived
    .filter((r) => r.type === "neo4j_edge")
    .flatMap((r) => {
      const relTable = `neo4j-rel:${r.label}`;
      if (!ids.has(relTable) || !ids.has(r.from) || !ids.has(r.to)) return [];
      const shared = { type: "neo4j_edge" as const, confidence: "exact" as const, uncertain: r.uncertain, evidence: r.evidence };
      return [
        { ...shared, id: `${r.id}#source`, fromTableId: r.from, toTableId: relTable, label: "source", doc: `${r.label} starts at this label.` },
        { ...shared, id: `${r.id}#target`, fromTableId: relTable, toTableId: r.to, label: "target", doc: `${r.label} ends at this label.` },
      ];
    });

  const schema: DatabaseSchema = {
    ...base,
    databases: base.databases.map((d) => ({ ...d, count: count(d.id) })),
    tables,
    relationships: [...relationships, ...membership],
  };

  const audit: SchemaAudit = {
    codeTables: code.length,
    documentedTables: base.tables.length,
    documentedUnused: base.tables.filter((t) => !byId.has(t.id)).map((t) => ({ id: t.id, name: t.name })),
    undocumented: fresh.map((c) => ({ id: c.table, name: c.name, fields: c.fields.length })),
    inferredFieldTables: code.filter((c) => c.fields.some((f) => f.source !== "model") ).length,
    staleFields: base.tables.flatMap((t) => {
      const c = byId.get(t.id);
      if (!c || c.fields.length === 0) return [];
      const seen = new Set(c.fields.map((f) => f.name));
      const exact = c.fields.some((f) => f.source === "model"); // a model class is the authority
      return t.fields
        .filter((f) => !seen.has(f.name) && f.name !== "_id" && f.name !== "id")
        .map((f) => ({ table: t.id, name: f.name, exact }));
    }),
    exactRelations: relationships.filter((r) => r.confidence === "exact").length,
    inferredRelations: relationships.filter((r) => r.confidence === "inferred").length,
    generation,
  };
  return { schema, audit };
}

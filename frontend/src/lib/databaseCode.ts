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
  type DatabaseFunctionUsage,
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

export interface CodeTable {
  table: string; // "mongo:quotation_rows" | "mongo:ChatSession" | "neo4j:KNode" | "neo4j-rel:IS_A"
  database: "mongodb" | "neo4j";
  kind: "collection" | "label" | "relationship";
  name: string;
  ops: Record<string, number>;
  uncertain: boolean;
  fields: CodeField[];
  functions: CodeFunction[];
  endpoints: CodeEndpoint[];
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
  /** functions / endpoints per table now come from code; nothing invented remains */
  generation: number;
}

export async function fetchCodeTables(): Promise<{ tables: CodeTable[]; generation: number }> {
  const res = await fetch("/viewer/routes/database");
  if (!res.ok) throw new Error(res.status === 503 ? "the analysis is still running" : `HTTP ${res.status}`);
  return (await res.json()) as { tables: CodeTable[]; generation: number };
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

export function mergeCodeIntoSchema(code: CodeTable[], generation: number): { schema: DatabaseSchema; audit: SchemaAudit } {
  const base = BRAIN_DATABASE_SCHEMA;
  const byId = new Map(code.map((c) => [c.table, c]));
  const documentedIds = new Set(base.tables.map((t) => t.id));

  // documented tables: keep the documentation, take the links (and any extra fields) from the code
  const tables: DatabaseTable[] = base.tables.map((t) => {
    const c = byId.get(t.id);
    if (!c) return { ...t, functions: [], endpoints: [] };
    const known = new Set(t.fields.map((f) => f.name));
    const extra = c.fields.filter((f) => !known.has(f.name)).map(inferredField);
    return { ...t, fields: [...t.fields, ...extra], functions: functionsOf(c), endpoints: endpointsOf(c) };
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
      indexes: [],
      functions: functionsOf(c),
      endpoints: endpointsOf(c),
      x: 60 + (i % GRID_COLS) * GRID_X,
      y: maxY + 90 + Math.floor(i / GRID_COLS) * GRID_Y,
    });
  });

  const count = (db: "mongodb" | "neo4j") => tables.filter((t) => t.database === db).length;
  const schema: DatabaseSchema = {
    ...base,
    databases: base.databases.map((d) => ({ ...d, count: count(d.id) })),
    tables,
  };

  const audit: SchemaAudit = {
    codeTables: code.length,
    documentedTables: base.tables.length,
    documentedUnused: base.tables.filter((t) => !byId.has(t.id)).map((t) => ({ id: t.id, name: t.name })),
    undocumented: fresh.map((c) => ({ id: c.table, name: c.name, fields: c.fields.length })),
    inferredFieldTables: code.filter((c) => c.fields.some((f) => f.source !== "model") ).length,
    generation,
  };
  return { schema, audit };
}

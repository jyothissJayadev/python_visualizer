export type DatabaseType = "mongodb" | "neo4j";
export type TableDomain = "quotation" | "execution" | "chat" | "shared";
export type RelationType = "mongo_fk" | "neo4j_edge" | "cross_database";

export interface DatabaseField {
  name: string;
  type: string;
  isPrimary?: boolean;
  isForeign?: boolean;
  foreignTarget?: string;
  doc?: string;
}

export interface DatabaseIndex {
  name: string;
  keys: string[];
  unique?: boolean;
  type?: string;
}

export interface DatabaseFunctionUsage {
  fnId: string;
  name: string;
  package: string;
  op: "read" | "write" | "upsert" | "delete";
  description?: string;
}

export interface DatabaseEndpointLineage {
  endpointId: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;
  summary?: string;
  callChain: string[];
}

export interface DatabaseTable {
  id: string; // e.g. "mongo:quotation_aliases" or "neo4j:Concept"
  database: DatabaseType;
  name: string;
  domain: TableDomain;
  type: "collection" | "graph_node";
  doc: string;
  fields: DatabaseField[];
  indexes: DatabaseIndex[];
  functions: DatabaseFunctionUsage[];
  endpoints: DatabaseEndpointLineage[];
  nodeCategories?: string[];
  edgeTypes?: string[];
  x?: number;
  y?: number;
}

export interface DatabaseRelationship {
  id: string;
  fromTableId: string;
  toTableId: string;
  fromField?: string;
  toField?: string;
  type: RelationType;
  label: string;
  doc?: string;
  /** "exact": stated outright by the code (a Cypher edge). "inferred": guessed from field names. */
  confidence?: "exact" | "inferred";
  /** an edge between labels that is only one of several possible (the label is chosen at runtime) */
  uncertain?: boolean;
  evidence?: { function_id: string | null; name: string }[];
}

export interface DatabaseSchema {
  databases: {
    id: DatabaseType;
    name: string;
    engine: string;
    count: number;
    color: string;
  }[];
  tables: DatabaseTable[];
  relationships: DatabaseRelationship[];
}

/**
 * Seed Database Schema derived deterministically from the Brain AST Architecture
 * (atomics_estimate_engine/apps/brain).
 */
export const BRAIN_DATABASE_SCHEMA: DatabaseSchema = {
  databases: [
    {
      id: "mongodb",
      name: "MongoDB",
      engine: "Motor Raw + Beanie ODM",
      count: 12,
      color: "var(--accent-emerald)",
    },
    {
      id: "neo4j",
      name: "Neo4j Graph",
      engine: "Cypher AsyncGraphDatabase",
      count: 4,
      color: "var(--accent-cyan)",
    },
  ],
  tables: [
    // ─────────────────────────────────────────────────────────────────────────
    // MONGODB: Quotation Collections
    // ─────────────────────────────────────────────────────────────────────────
    {
      id: "mongo:quotation_quotations",
      database: "mongodb",
      name: "quotation_quotations",
      domain: "quotation",
      type: "collection",
      doc: "Root quotation document storing raw quotation metadata, client info, and extraction lifecycle status.",
      fields: [
        { name: "_id", type: "ObjectId", isPrimary: true, doc: "MongoDB BSON ObjectId" },
        { name: "quotation_id", type: "string", doc: "Deterministic unique quotation identifier" },
        { name: "filename", type: "string", doc: "Source file uploaded (e.g. PDF, XLSX)" },
        { name: "client_name", type: "string", doc: "Customer or project name" },
        { name: "status", type: "string", doc: "Lifecycle state: uploaded, extracted, committed" },
        { name: "created_at", type: "float", doc: "Epoch timestamp of creation" },
      ],
      indexes: [],
      functions: [],
      endpoints: [],
      x: 60,
      y: 60,
    },
    {
      id: "mongo:quotation_sections",
      database: "mongodb",
      name: "quotation_sections",
      domain: "quotation",
      type: "collection",
      doc: "Logical spatial sections inside a quotation (e.g., Living Room, Foyer, Kitchen, Master Bedroom).",
      fields: [
        { name: "_id", type: "ObjectId", isPrimary: true },
        { name: "section_id", type: "string", doc: "Unique section ID" },
        { name: "quotation_id", type: "string", isForeign: true, foreignTarget: "mongo:quotation_quotations.quotation_id" },
        { name: "title", type: "string", doc: "Section name" },
        { name: "order", type: "int", doc: "Display sequence order" },
      ],
      indexes: [],
      functions: [],
      endpoints: [],
      x: 420,
      y: 60,
    },
    {
      id: "mongo:quotation_rows",
      database: "mongodb",
      name: "quotation_rows",
      domain: "quotation",
      type: "collection",
      doc: "Granular estimate line items containing description, quantity, pricing, and unit breakdown.",
      fields: [
        { name: "_id", type: "ObjectId", isPrimary: true },
        { name: "row_id", type: "string", doc: "Item row unique ID" },
        { name: "quotation_id", type: "string", isForeign: true, foreignTarget: "mongo:quotation_quotations.quotation_id" },
        { name: "section_id", type: "string", isForeign: true, foreignTarget: "mongo:quotation_sections.section_id" },
        { name: "raw_text", type: "string", doc: "Original line item text from estimate" },
        { name: "quantity", type: "float", doc: "Estimated quantity" },
        { name: "rate", type: "float", doc: "Unit rate" },
        { name: "amount", type: "float", doc: "Total row cost" },
        { name: "unit", type: "string", doc: "Measurement unit (sft, nos, rft)" },
      ],
      indexes: [],
      functions: [],
      endpoints: [],
      x: 780,
      y: 60,
    },
    {
      id: "mongo:quotation_extractions",
      database: "mongodb",
      name: "quotation_extractions",
      domain: "quotation",
      type: "collection",
      doc: "Raw entity extraction attributes extracted by Gemini LLM from raw item text.",
      fields: [
        { name: "_id", type: "ObjectId", isPrimary: true },
        { name: "extraction_id", type: "string", doc: "Extraction unique ID" },
        { name: "row_id", type: "string", isForeign: true, foreignTarget: "mongo:quotation_rows.row_id" },
        { name: "item_name", type: "string", doc: "Detected Item name" },
        { name: "work_category", type: "string", doc: "Civil, Carpentry, Electrical, Plumbing" },
        { name: "confidence", type: "float", doc: "LLM extraction confidence 0.0 - 1.0" },
      ],
      indexes: [],
      functions: [],
      endpoints: [],
      x: 1140,
      y: 60,
    },
    {
      id: "mongo:quotation_aliases",
      database: "mongodb",
      name: "quotation_aliases",
      domain: "quotation",
      type: "collection",
      doc: "Cached semantic alias embeddings pointing to canonical Neo4j concept ontology nodes.",
      fields: [
        { name: "_id", type: "ObjectId", isPrimary: true },
        { name: "alias_id", type: "string" },
        { name: "normalized_text", type: "string", doc: "Canonical lower-cased text" },
        { name: "category", type: "string" },
        { name: "node_id", type: "string", isForeign: true, foreignTarget: "neo4j:Concept.id", doc: "Foreign key linking directly to Neo4j Concept Node" },
      ],
      indexes: [],
      functions: [],
      endpoints: [],
      x: 60,
      y: 400,
    },
    {
      id: "mongo:quotation_ambiguity_records",
      database: "mongodb",
      name: "quotation_ambiguity_records",
      domain: "quotation",
      type: "collection",
      doc: "Logs unresolved concepts where multiple Neo4j candidate nodes matched with close similarity scores.",
      fields: [
        { name: "_id", type: "ObjectId", isPrimary: true },
        { name: "ambiguity_id", type: "string" },
        { name: "quotation_id", type: "string", isForeign: true, foreignTarget: "mongo:quotation_quotations.quotation_id" },
        { name: "candidate_node_ids", type: "string[]", isForeign: true, foreignTarget: "neo4j:Concept.id", doc: "List of competing candidate Neo4j concept node IDs" },
        { name: "resolved", type: "boolean" },
      ],
      indexes: [],
      functions: [],
      endpoints: [],
      x: 420,
      y: 400,
    },
    {
      id: "mongo:quotation_merge_proposals",
      database: "mongodb",
      name: "quotation_merge_proposals",
      domain: "quotation",
      type: "collection",
      doc: "Proposals for deduplicating or merging two Neo4j concept nodes, awaiting admin review or automated approval.",
      fields: [
        { name: "_id", type: "ObjectId", isPrimary: true },
        { name: "proposal_id", type: "string" },
        { name: "winner_node_id", type: "string", isForeign: true, foreignTarget: "neo4j:Concept.id" },
        { name: "loser_node_id", type: "string", isForeign: true, foreignTarget: "neo4j:Concept.id" },
        { name: "similarity_score", type: "float" },
        { name: "status", type: "string", doc: "pending, approved, rejected" },
      ],
      indexes: [],
      functions: [],
      endpoints: [],
      x: 780,
      y: 400,
    },
    {
      id: "mongo:quotation_commit_reports",
      database: "mongodb",
      name: "quotation_commit_reports",
      domain: "quotation",
      type: "collection",
      doc: "Permanent commit audit logs recording graph nodes created, edges created, and validation metrics.",
      fields: [
        { name: "_id", type: "ObjectId", isPrimary: true },
        { name: "report_id", type: "string" },
        { name: "quotation_id", type: "string", isForeign: true, foreignTarget: "mongo:quotation_quotations.quotation_id" },
        { name: "nodes_created", type: "int" },
        { name: "edges_created", type: "int" },
        { name: "committed_at", type: "float" },
      ],
      indexes: [],
      functions: [],
      endpoints: [],
      x: 1140,
      y: 400,
    },

    // ─────────────────────────────────────────────────────────────────────────
    // MONGODB: Chat & Dialogue Context Collections
    // ─────────────────────────────────────────────────────────────────────────
    {
      id: "mongo:ChatSession",
      database: "mongodb",
      name: "ChatSession",
      domain: "chat",
      type: "collection",
      doc: "Stores conversational session history, turn traces, and user prompt dialogue.",
      fields: [
        { name: "_id", type: "ObjectId", isPrimary: true },
        { name: "session_id", type: "string" },
        { name: "project_id", type: "string", isForeign: true, foreignTarget: "neo4j:KNode.project_id", doc: "Foreign key linking to Neo4j KNode project_id" },
        { name: "domain", type: "string" },
        { name: "messages", type: "list[Message]" },
      ],
      indexes: [],
      functions: [],
      endpoints: [],
      x: 60,
      y: 700,
    },
    {
      id: "mongo:ProjectContext",
      database: "mongodb",
      name: "ProjectContext",
      domain: "chat",
      type: "collection",
      doc: "Persists extracted project facts, client preferences, and conversational constraint dicts.",
      fields: [
        { name: "_id", type: "ObjectId", isPrimary: true },
        { name: "project_id", type: "string" },
        { name: "summary", type: "string" },
      ],
      indexes: [],
      functions: [],
      endpoints: [],
      x: 420,
      y: 700,
    },

    // ─────────────────────────────────────────────────────────────────────────
    // MONGODB: Execution Collections
    // ─────────────────────────────────────────────────────────────────────────
    {
      id: "mongo:execution_ext_plans",
      database: "mongodb",
      name: "execution_ext_plans",
      domain: "execution",
      type: "collection",
      doc: "Execution plans compiled from committed estimates containing DAG schedule and milestones.",
      fields: [
        { name: "_id", type: "ObjectId", isPrimary: true },
        { name: "plan_id", type: "string" },
        { name: "title", type: "string" },
        { name: "status", type: "string" },
      ],
      indexes: [],
      functions: [],
      endpoints: [],
      x: 780,
      y: 700,
    },
    {
      id: "mongo:execution_ext_tasks",
      database: "mongodb",
      name: "execution_ext_tasks",
      domain: "execution",
      type: "collection",
      doc: "Individual decomposed execution tasks with dependency references.",
      fields: [
        { name: "_id", type: "ObjectId", isPrimary: true },
        { name: "task_id", type: "string" },
        { name: "plan_id", type: "string", isForeign: true, foreignTarget: "mongo:execution_ext_plans.plan_id" },
        { name: "name", type: "string" },
        { name: "dependencies", type: "string[]" },
      ],
      indexes: [],
      functions: [],
      endpoints: [],
      x: 1140,
      y: 700,
    },

    // ─────────────────────────────────────────────────────────────────────────
    // NEO4J: Graph Entities
    // ─────────────────────────────────────────────────────────────────────────
    {
      id: "neo4j:Concept",
      database: "neo4j",
      name: "Concept",
      domain: "quotation",
      type: "graph_node",
      doc: "Quotation domain ontology graph nodes. Represents architectural elements, work categories, rooms, materials, and hardware.",
      fields: [
        { name: "id", type: "string (UUID)", isPrimary: true, doc: "Unique Concept Node ID" },
        { name: "name", type: "string", doc: "Normalized concept name (e.g. 'Wardrobe', 'Plywood')" },
        { name: "category", type: "string", doc: "root, work_category, room_type, Item, Material, Finish, Hardware" },
        { name: "node_type", type: "string", doc: "'Concept', 'root', or 'anchor'" },
        { name: "layer", type: "string", doc: "'primary' (the item) or 'secondary' (material/finish/hardware)" },
        { name: "node_weight", type: "float", doc: "Dynamic trust weight (0.0 to 1.0)" },
        { name: "centrality", type: "float", doc: "PageRank centrality score" },
        { name: "repetition_count", type: "int", doc: "Frequency across quotation commits" },
      ],
      indexes: [],
      nodeCategories: ["root", "work_category", "room_type", "Item", "Material", "Finish", "Hardware", "Feature"],
      edgeTypes: ["IS_A", "MADE_OF", "HAS_FINISH", "HAS_HARDWARE", "HAS_PART", "LOCATED_IN", "COOCCURS_WITH"],
      functions: [],
      endpoints: [],
      x: 1540,
      y: 60,
    },
    {
      id: "neo4j:Context",
      database: "neo4j",
      name: "Context",
      domain: "quotation",
      type: "graph_node",
      doc: "Evidence graph node capturing statistical co-occurrence patterns between concepts in actual quotations.",
      fields: [
        { name: "id", type: "string", isPrimary: true },
        { name: "scope", type: "string", doc: "Contextual scope (e.g. room or section)" },
        { name: "context_properties", type: "json" },
      ],
      indexes: [],
      edgeTypes: ["EVIDENCE_FOR"],
      functions: [],
      endpoints: [],
      x: 1900,
      y: 60,
    },
    {
      id: "neo4j:KNode",
      database: "neo4j",
      name: "KNode",
      domain: "chat",
      type: "graph_node",
      doc: "Dialogue Knowledge Tree node storing canonical hierarchical paths, project values, and versioned entity facts.",
      fields: [
        { name: "node_id", type: "string", isPrimary: true },
        { name: "project_id", type: "string", doc: "Links to ChatSession.project_id" },
        { name: "canonical_path", type: "string", doc: "Hierarchical path (e.g. project.rooms.kitchen.modular_wardrobe)" },
        { name: "node_type", type: "string", doc: "container, property, leaf" },
        { name: "value", type: "any" },
        { name: "lifecycle", type: "string", doc: "active, superseded, deleted" },
      ],
      indexes: [],
      edgeTypes: ["CHILD_OF", "REL"],
      functions: [],
      endpoints: [],
      x: 1540,
      y: 520,
    },
    {
      id: "neo4j:Entity",
      database: "neo4j",
      name: "Entity",
      domain: "execution",
      type: "graph_node",
      doc: "Execution domain ontology graph nodes for execution tasks, sequencing rules, and dependency graphs.",
      fields: [
        { name: "id", type: "string", isPrimary: true },
        { name: "name", type: "string" },
        { name: "category", type: "string" },
        { name: "status", type: "string" },
      ],
      indexes: [],
      edgeTypes: ["DEPENDS_ON", "EXECUTES"],
      functions: [],
      endpoints: [],
      x: 1900,
      y: 520,
    },
  ],

  // ───────────────────────────────────────────────────────────────────────────
  // RELATIONSHIPS (Intra-Mongo, Neo4j Edges, & Cross-Database Links)
  // ───────────────────────────────────────────────────────────────────────────
  relationships: [],
};

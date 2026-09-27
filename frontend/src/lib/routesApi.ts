/* routesApi.ts — typed client for the Routes API (backend/api/routes.py).
   Endpoint ids contain "/" and "{}", so they always travel as query params. */

export interface AnalysisStatus {
  status: "idle" | "scanning" | "error";
  reason: string | null;
  error: string | null;
  ready: boolean;
  generation: number;
  fingerprint: string | null;
  analyzed_at: number | null;
  duration_ms: number | null;
  project_path: string;
  endpoint_count: number;
  from_cache: boolean;
  stale?: boolean;
}

export interface EndpointSummary {
  id: string;
  method: string;
  path: string;
  handler_id: string;
  handler_name: string;
  file_path: string;
  line: number;
  summary: string | null;
  tags: string[];
  is_async: boolean;
  conditional: boolean;
  factory: string | null;
  param_app: boolean;
}

export interface EndpointGroup {
  prefix: string;
  count: number;
  endpoints: EndpointSummary[];
}

/** Is brain running the code that is on disk? (brain reports when it started; any file newer than that
    means the running process is older than the analysis.) */
export interface BrainCode {
  state: "current" | "older" | "unknown";
  connected: boolean;
  newer_files: number;
  newest_file: string | null;
  newest_at?: string | null;
}

export interface RoutesListing {
  analysis: AnalysisStatus;
  brain_code?: BrainCode;
  groups: EndpointGroup[];
  unmounted: { id: string; file_path: string; line: number; route_count: number }[];
  errors: string[];
}

export interface EndpointDetail extends EndpointSummary {
  signature: string;
  docstring: string | null;
  response_model: string | null;
  status_code: string | null;
  dependencies: string[];
  dependency_ids: string[];
  mount_chain: string[];
  bindings: Record<string, string | null>;
}

export type NodeKind =
  | "function"
  | "external"
  | "unresolved"
  | "class"
  | "loop"
  | "branch"
  | "arm"
  | "graph"
  | "dispatch";

/** A call that is not a node in the hierarchy: library / built-in function,
    class instantiation, or a call that could not be resolved statically. */
export interface LibraryCall {
  kind: "external" | "class" | "unresolved";
  name: string;
  count: number;
  line?: number | null;
  reason?: string;
}

export type TableOp = "read" | "write" | "upsert" | "delete";
/** "unknown" only appears on calls that could not be tied to a table */
export type DataOp = TableOp | "unknown";

/** A database table a function reads or writes (derived from the code). */
export interface DataAccess {
  /** "mongo:quotation_rows" | "mongo:ChatSession" | "neo4j:KNode" | "neo4j-rel:IS_A";
      "?" when a database call could not be tied to any table */
  table: string;
  op: DataOp;
  count: number;
  /** one of several possible labels (e.g. chosen by domain at runtime) */
  uncertain?: boolean;
  /** a database call that could not be tied to a table */
  unattributed?: boolean;
  via?: string; // the call it was found through ("run", "execute_write", …)
  expr?: string;
  line?: number;
  reason?: string;
}

/** One table an endpoint touches, and which functions are responsible. */
export interface TableUsage {
  table: string;
  database: "mongodb" | "neo4j";
  kind: "collection" | "label" | "relationship";
  name: string;
  ops: Partial<Record<TableOp, number>>;
  /** true when the table is only ever "one of several possible labels" */
  uncertain: boolean;
  functions: { function_id: string | null; name: string; op: TableOp; count: number; path: string; uncertain?: boolean }[];
}

/** How completely the endpoint's database access could be tied to tables. */
export interface DataAudit {
  functions: number; // functions in the hierarchy that touch the database
  matched: number; // ...of which every access was tied to a table
  unmatched: {
    function_id: string | null;
    name: string;
    path: string;
    op: DataOp;
    via?: string | null;
    expr?: string | null;
    line?: number | null;
    reason?: string | null;
    count: number;
  }[];
}

export interface EndpointData {
  endpoint_id: string;
  generation: number;
  tables: TableUsage[];
  audit: DataAudit;
}

export interface TreeNode {
  id: string; // index path from the handler: "0", "0.3", "0.3.1"
  kind: NodeKind;
  name: string;
  edge?: string; // call | await | spawn | callback | depends | graph_node | router | instantiate | handler
  function_id?: string;
  file_path?: string;
  line?: number;
  signature?: string;
  doc?: string;
  call_line?: number;
  call_expr?: string;
  label?: string;
  external?: string;
  is_async?: boolean;
  cyclic?: boolean;
  meta?: {
    count?: number;
    stub?: boolean;
    reason?: string;
    graph?: { name: string; next: { to: string; label: string | null }[] };
    data?: DataAccess[]; // database tables this function itself reads / writes
    library?: LibraryCall[]; // only on the node that was requested with depth=0
    library_count?: number; // calls to library / built-in / unresolved functions made by this function
    below_count?: number; // distinct tables touched by anything this function calls (not by itself)
    below?: string[]; // ...the tables themselves; only on the node that was requested with depth=0
    library_more?: number;
  };
  children?: TreeNode[];
  children_count?: number; // present when children exist but were cut by the depth limit
}

export interface TreeStats {
  function: number; // user-defined functions in the hierarchy
  external: number; // library / built-in calls (not shown as nodes)
  unresolved: number;
  class: number;
  cyclic: number;
  max_depth: number;
  coverage: number;
  nodes: number;
}

export interface TreeResponse {
  endpoint_id: string;
  path: string;
  generation: number;
  stats: TreeStats;
  node: TreeNode;
}

export interface FunctionDetail {
  id: string;
  name: string;
  qual: string;
  module: string;
  file_path: string;
  line: number;
  end_line: number;
  signature: string;
  is_async: boolean;
  decorators: string[];
  class_id: string | null;
  docstring: string | null;
  source: string | null;
  source_truncated: boolean;
}

export interface LastCall {
  request_id: string;
  span_id: string;
  ts: number | null;
  duration_ms: number | null;
  args: unknown;
  args_truncated: boolean;
  result: unknown;
  result_truncated: boolean;
  error: { type?: string; message?: string } | null;
}

export interface FnRuntime {
  calls: number;
  requests: number;
  avg_ms: number;
  max_ms: number;
  errors: number;
  last: LastCall | null;
}

export interface RuntimeOverlay {
  endpoint_id: string;
  request_count: number;
  requests: { request_id: string; ts: number | null; status: number | null; duration_ms: number | null; spans: number }[];
  span_count: number;
  functions: Record<string, FnRuntime>;
  confirmed: string[]; // "callerFunctionId>calleeFunctionId"
  armed: Record<string, boolean>; // function id -> deep?
  extras: Record<string, { function_id: string; calls: number }[]>; // seen under a function, absent from its static subtree
  brain_connected: boolean;
  generation: number;
}

export interface ArmResult {
  ok: boolean;
  armed?: string[];
  unresolved?: { id: string }[];
  error?: string;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = ((await res.json()) as { detail?: string }).detail ?? detail;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const q = (params: Record<string, string | number>) =>
  new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();

export const routesApi = {
  list: () => getJson<RoutesListing>("/viewer/routes"),
  endpoint: (id: string) => getJson<EndpointDetail>(`/viewer/routes/endpoint?${q({ id })}`),
  tree: (id: string, path: string, depth: number) =>
    getJson<TreeResponse>(`/viewer/routes/tree?${q({ id, path, depth })}`),
  fn: (id: string) => getJson<FunctionDetail>(`/viewer/routes/function?${q({ id })}`),
  status: () => getJson<AnalysisStatus>("/viewer/routes/status"),
  data: (id: string) => getJson<EndpointData>(`/viewer/routes/data?${q({ id })}`),
  runtime: (id: string) => getJson<RuntimeOverlay>(`/viewer/routes/runtime?${q({ id })}`),
  arm: (id: string, armed: boolean) =>
    getJson<ArmResult>("/viewer/routes/arm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, armed, deep: true }),
    }),
  rescan: () =>
    getJson<AnalysisStatus & { changed: boolean }>("/viewer/routes/rescan", { method: "POST" }),
};

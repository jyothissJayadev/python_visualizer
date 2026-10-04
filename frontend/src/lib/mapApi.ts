/* mapApi.ts — typed client for the Map API (backend/api/map.py). Ids contain ":" and "/",
   so they always travel as query params. */

export interface MapMetrics {
  fan_in: number;
  fan_out: number;
  io: string[];
  endpoints: number;
  branches: number;
  loc: number;
  private: boolean;
}

export interface MapFunction {
  id: string;
  name: string;
  qual: string;
  module: string;
  file_path: string;
  line: number;
  end_line: number;
  signature: string;
  doc: string | null;
  is_async: boolean;
  layer: string;
  role: "main" | "child";
  score: number;
  reasons: string[];
  metrics: MapMetrics;
  depth: number | null;
  endpoints: string[];
  unresolved_calls: number;
  children?: string[];
  used_by?: string[];
  shared?: boolean;
}

export interface MapModule {
  module: string;
  layer: string;
  file_path: string;
  functions: string[];
}

export interface MapEdge {
  from: string;
  to: string;
  kind: string;
  via: string[];
}

export interface MapEntry {
  id: string;
  kind: string;
  framework: string;
  module: string;
  file_path: string | null;
  line: number;
}

export interface ProjectMap {
  project_path: string;
  entry_points: MapEntry[];
  endpoints: { id: string; method: string; path: string; handler_id: string; summary: string | null }[];
  layers: string[];
  modules: MapModule[];
  functions: Record<string, MapFunction>;
  edges: MapEdge[];
  unreached: string[];
  stats: { functions: number; main: number; child: number; edges: number; unreached: number };
}

export interface AlgoStep {
  id: string;
  kind: string;
  ref: string | null;
  text: string;
  label: string;
  note?: string;
  line: number | null;
  count?: number;
  recursive?: boolean;
  children: AlgoStep[];
}

export interface AlgorithmCard {
  function_id: string;
  body_hash: string;
  facts: { raises: string[]; returns: number; decorators: string[]; signature: string };
  purpose: string;
  fill_status: "filled" | "deterministic" | "stale";
  steps: AlgoStep[];
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export const mapApi = {
  map: () => fetch("/viewer/map").then((r) => json<ProjectMap>(r)),
  algorithm: (id: string) =>
    fetch(`/viewer/map/algorithm?${new URLSearchParams({ id })}`).then((r) => json<AlgorithmCard>(r)),
  pin: (id: string, role: "main" | "child" | null) =>
    fetch("/viewer/map/overrides", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, role }),
    }).then((r) => json<Record<string, string>>(r)),
};

/* ── telelog (backend/api/telelog.py) ── */

export type TagStatus = "ok" | "stale" | "invalid";

export interface TagField {
  name: string;
  optional: boolean;
  source: string | null;
}

export interface EndpointInfo {
  id: string;
  method: string;
  path: string;
  status_code: string | null;
  response_model: string | null;
  dependencies: string[];
  summary: string | null;
}

export interface EntryPoint {
  id: string;
  kind: string;
  framework: string | null;
  module: string;
  file_path: string | null;
  line: number | null;
}

export interface TelelogFn {
  id: string;
  role: "main" | "sub" | "helper" | null;
  feature: string | null;
  parent: string | null;
  n: number | null;
  purpose: string | null;
  inputs: TagField[] | null;
  outputs: TagField[] | null;
  db: { table: string; mode: string }[] | null;
  algo: string[] | null;
  problems: { code: string; message: string; line: number }[];
  status: TagStatus;
  tables: string[];
  routes: string[];
  endpoints: EndpointInfo[];
  line: number | null;
  file: string | null;
  module: string;
  signature: string | null;
}

export interface TelelogFeature {
  name: string;
  mains: string[];
  functions: number;
  endpoints: number;
  tables: string[];
}

export interface TelelogMapData {
  features: TelelogFeature[];
  functions: Record<string, TelelogFn>;
  children: Record<string, string[]>;
  untagged: Record<string, string[]>;
  /** module -> source file, for every module that has functions */
  files: Record<string, string>;
  entry_points: EntryPoint[];
  endpoint_count: number;
  /** caller id -> direct calls to other tagged functions (call sites counted) */
  calls: Record<string, { to: string; n: number; edge: string }[]>;
  coverage: { tagged: number; total: number; stale: number; invalid: number };
}

export interface LiveField {
  state: "sample" | "no-sample" | "redacted";
  value?: string;
}

export interface LiveValues {
  status: "ok" | "no-trace";
  request_id?: string;
  ts?: number;
  inputs: Record<string, LiveField>;
  outputs: Record<string, LiveField>;
}

export interface FlowStep {
  i: number;
  kind: "fn" | "db" | "external";
  id: string;
  depth: number;
  parent: number | null;
  edge: string;
  line: number | null;
  expr: string | null;
  repeat: boolean;
  recursive: boolean;
}

export interface FlowData {
  handler: string;
  route: string | null;
  steps: FlowStep[];
  truncated: boolean;
}

export const telelogApi = {
  map: () => fetch("/viewer/telelog/map").then((r) => json<TelelogMapData>(r)),
  /** the order an endpoint's code runs in, depth first */
  flow: (id: string) => fetch(`/viewer/telelog/flow?${new URLSearchParams({ id })}`).then((r) => json<FlowData>(r)),
  /** capped source of one function, for the code preview */
  source: (id: string) =>
    fetch(`/viewer/telelog/function?${new URLSearchParams({ ids: id })}`)
      .then((r) => json<{ source?: { text: string; truncated: boolean } }[]>(r))
      .then((a) => a[0]?.source ?? null),
  live: (id: string) => fetch(`/viewer/telelog/live?${new URLSearchParams({ id })}`).then((r) => json<LiveValues>(r)),
};

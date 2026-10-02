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

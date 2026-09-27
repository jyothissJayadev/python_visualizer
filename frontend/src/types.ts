/* Wire types for the Brain Terminal — mirrors backend/api/viewer.py and the
   trace events brain streams through it. */

export type EventKind =
  | "request.start"
  | "request.end"
  | "fn.start"
  | "fn.end"
  | "fn.error"
  | "llm.call"
  | "log";

export interface TokenUsage {
  in?: number;
  out?: number;
}

export interface ChatMessage {
  role?: string;
  content?: string;
}

/** The `data` payload varies by kind — every field is optional. */
export interface EventData {
  // request.start / request.end
  method?: string;
  path?: string;
  summary?: string;
  status?: number;
  duration_ms?: number;
  // fn.start / fn.end / fn.error
  name?: string; // "module:QualName"
  qualname?: string;
  module?: string;
  signature?: string;
  args?: unknown;
  args_truncated?: boolean;
  result?: unknown;
  result_truncated?: boolean;
  exc_type?: string;
  message?: string;
  traceback?: string;
  line?: string;
  // llm.call
  label?: string;
  model?: string;
  tokens?: TokenUsage;
  messages?: ChatMessage[];
  raw_text?: string;
  parsed?: unknown;
  // log
  level?: string;
}

export interface TraceEvent {
  kind: EventKind | string;
  request_id?: string;
  span_id?: string;
  parent_span_id?: string | null;
  depth?: number;
  seq?: number;
  ts?: number;
  data?: EventData;
}

/* ---- control-plane messages (over the same socket) ---- */

export interface ValueMessage {
  kind: "value";
  span_id: string;
  field: "args" | "result" | string;
  value?: unknown;
  error?: string;
}

export interface SelectionAppliedMessage {
  kind: "selection_applied";
  armed?: string[];
  unresolved?: { id: string }[];
  error?: string;
}

export interface CodeStatusMessage {
  kind: "code_status";
  in_sync: boolean | null;
  brain: string | null;
}

/** Another dashboard (or this one) cleared the stream; wipe local state. */
export interface ClearedMessage {
  kind: "cleared";
}

export type IncomingMessage =
  | ValueMessage
  | SelectionAppliedMessage
  | CodeStatusMessage
  | ClearedMessage
  | TraceEvent;

export interface ApplySelectionOp {
  op: "apply_selection";
  selections: { id: string; deep: boolean }[];
}
export interface GetValueOp {
  op: "get_value";
  request_id: string;
  span_id: string;
  field: "args" | "result";
}
export interface ClearOp {
  op: "clear";
}
export type ClientOp = ApplySelectionOp | GetValueOp | ClearOp;

/* ---- function catalogue ---- */

export interface CatalogFunction {
  id: string; // "module:QualName"
  name: string; // QualName
  package: string; // dotted module
  signature: string;
  doc: string;
  is_async: boolean;
  file: string;
  line: number;
}

export interface CatalogGroup {
  package: string;
  functions: CatalogFunction[];
}

export interface Catalog {
  fingerprint?: string;
  groups: CatalogGroup[];
}

/* ---- trace templates ---- */

export interface TemplateFunction {
  id: string; // "module:QualName"
  deep: boolean;
  status?: "ok" | "missing" | "unknown"; // annotated live by the backend against the current catalog; display-only
  suggestions?: string[]; // up to 3 close-match ids when status is "missing"
}

export interface Template {
  id: string;
  name: string;
  functions: TemplateFunction[];
  created_at: string;
  updated_at: string;
}

/* ---- derived, in-memory ---- */

export interface SpanData {
  span_id: string;
  request_id: string;
  parent_span_id: string | null;
  depth: number;
  kind: string;
  order: number; // arrival order, for stable sibling sequencing
  startEvent: TraceEvent | null;
  endEvent: TraceEvent | null;
  errorEvent: TraceEvent | null;
  llmEvent: TraceEvent | null;
}

export interface RequestData {
  id: string;
  startEvent: TraceEvent | null;
  endEvent: TraceEvent | null;
  spanIds: string[];
}

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "down";

export interface LoopGroup {
  key: string;
  reqId: string;
  memberSpanIds: string[];
  expanded: boolean;
}

// ── Lineage Cross-Layer Types ───────────────────────────────────────────────
export type LineageChainStatus =
  | "full_chain"
  | "client_api"
  | "backend_exposed"
  | "service_only"
  | "unexposed";

export interface LineageEndpoint {
  id: string;
  method: string;
  path: string;
  handler_id: string;
  handler_name: string;
  file_path: string;
  line: number;
  summary?: string | null;
  docstring?: string | null;
  tags?: string[];
  is_async?: boolean;
  conditional?: boolean;
  factory?: string | null;
}

export interface LineageServiceCall {
  serviceFunc: string;
  rawPath: string;
  cleanPath: string;
  method: string;
  file: string;
  line: number;
}

export interface LineageController {
  controllerFunc: string;
  file: string;
  line: number;
}

export interface LineageExpressRoute {
  method: string;
  fullPath: string;
  subPath: string;
  file: string;
  line: number;
}

export interface LineageBackendBridge {
  service: LineageServiceCall;
  controller: LineageController | null;
  routes: LineageExpressRoute[];
}

export interface LineageClientApi {
  app: "admin" | "frontend";
  apiFunc: string;
  url: string;
  rawUrl?: string;
  method: string;
  file: string;
  line: number;
}

export interface LineageUiUsage {
  app: "admin" | "frontend";
  apiFunc: string;
  component: string;
  callerFunc: string;
  file: string;
  line: number;
  snippet?: string;
}

export interface LineageClientBridge {
  app: "admin" | "frontend";
  api: LineageClientApi;
  ui: LineageUiUsage[];
}

export interface LineageChainStats {
  services_count: number;
  routes_count: number;
  client_apis_count: number;
  ui_usages_count: number;
}

export interface LineageChain {
  id: string;
  method: string;
  path: string;
  domain: string;
  endpoint: LineageEndpoint;
  backend: LineageBackendBridge[];
  clients: LineageClientBridge[];
  status: LineageChainStatus;
  stats: LineageChainStats;
}

export interface LineageSummary {
  total_brain_endpoints: number;
  full_chain_count: number;
  client_api_count: number;
  backend_exposed_count: number;
  service_only_count: number;
  unexposed_count: number;
  admin_connected_count: number;
  frontend_connected_count: number;
}

export interface LineageAnalysisResponse {
  status: "idle" | "scanning" | "error";
  error?: string | null;
  /** the code changed since this was scanned */
  stale?: boolean;
  last_scanned_at?: number | null;
  timestamp?: number;
  duration_ms?: number;
  directories?: {
    brain: string;
    backend: string;
    frontend: string;
    admin: string;
  };
  summary: LineageSummary;
  chains: LineageChain[];
}


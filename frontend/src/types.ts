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
  value: unknown;
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

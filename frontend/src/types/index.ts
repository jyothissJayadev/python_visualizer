export interface ParameterInfo {
  name: string;
  annotation: string | null;
  default: string | null;
  kind: string;
  required: boolean;
}

export interface FunctionInfo {
  function_id: string;
  name: string;
  qualified_name: string;
  file_path: string;
  module: string;
  class_name: string | null;
  line_number: number;
  end_line_number: number;
  parameters: ParameterInfo[];
  return_annotation: string | null;
  decorators: string[];
  is_async: boolean;
  docstring: string | null;
}

export interface FunctionDetail extends FunctionInfo {
  source: string;
}

export interface ScanError {
  file_path: string;
  message: string;
  line_number: number | null;
}

export interface ClassInfo {
  name: string;
  qualified_name: string;
  file_path: string;
  module: string;
  line_number: number;
  end_line_number: number;
  decorators: string[];
  docstring: string | null;
  methods: FunctionInfo[];
}

export interface ModuleInfo {
  file_path: string;
  module: string;
  functions: FunctionInfo[];
  classes: ClassInfo[];
}

export interface ScanResult {
  project_path: string;
  modules: ModuleInfo[];
  errors: ScanError[];
  scanned_file_count: number;
}

export interface TraceCall {
  call_id: number;
  qualname: string;
  module: string;
  file: string;
  line: number;
  args: Record<string, unknown>;
  return_value: unknown;
  returned: boolean;
  exception: string | null;
  duration_ms: number;
  depth: number;
  children: TraceCall[];
  children_truncated: boolean;
}

export interface TraceRecord {
  trace_id: string;
  kind: string;
  label: string;
  method: string | null;
  path: string | null;
  status_code: number | null;
  started_at: string;
  duration_ms: number;
  call_count: number;
  truncated: boolean;
  error: string | null;
  roots: TraceCall[];
}

export type TraceSummary = Omit<TraceRecord, "roots">;

export interface ExecutionResult {
  success: boolean;
  output: unknown;
  error_type: string | null;
  error_message: string | null;
  traceback: string | null;
  duration_ms: number;
  trace: TraceRecord | null;
  trace_id: string | null;
}

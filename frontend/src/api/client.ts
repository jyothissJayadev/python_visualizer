import type {
  ExecutionResult,
  FunctionDetail,
  FunctionInfo,
  ScanResult,
  TraceRecord,
  TraceSummary,
} from "../types";

const BASE_URL = "http://127.0.0.1:8765";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  getProject: () => request<ScanResult>("/api/project"),
  rescan: () => request<ScanResult>("/api/project/rescan", { method: "POST" }),
  listFunctions: () => request<FunctionInfo[]>("/api/functions"),
  getFunction: (functionId: string) => request<FunctionDetail>(`/api/functions/${functionId}`),
  executeFunction: (functionId: string, args: Record<string, unknown>, trace = false) =>
    request<ExecutionResult>(`/api/functions/${functionId}/execute`, {
      method: "POST",
      body: JSON.stringify({ arguments: args, trace }),
    }),
  listTraces: () => request<TraceSummary[]>("/api/traces"),
  getTrace: (traceId: string) => request<TraceRecord>(`/api/traces/${traceId}`),
  clearTraces: () => request<void>("/api/traces/clear", { method: "POST" }),
};

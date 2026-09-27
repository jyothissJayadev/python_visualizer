import type { LineageAnalysisResponse, LineageChain } from "../types";

export class ApiError extends Error {
  status: number;
  body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { Accept: "application/json", ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => null);
    }
    const msg =
      typeof body === "object" && body && "detail" in body
        ? String((body as { detail: unknown }).detail)
        : `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, body);
  }
  return res.json() as Promise<T>;
}

export const lineageApi = {
  getLineage: (force: boolean = false) =>
    request<LineageAnalysisResponse>(`/viewer/lineage${force ? "?force=true" : ""}`),

  getChain: (id: string) =>
    request<{ chain: LineageChain }>(`/viewer/lineage/chain?id=${encodeURIComponent(id)}`),

  rescan: () =>
    request<LineageAnalysisResponse>("/viewer/lineage/rescan", { method: "POST" }),
};

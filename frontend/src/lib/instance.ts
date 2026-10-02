import { useSyncExternalStore } from "react";

export type Feature = "terminal" | "routes" | "database" | "lineage" | "map";

export interface InstanceInfo {
  name: string;
  project: string;
  features: Feature[];
  port: number | null;
  loaded: boolean;
}

const ALL: Feature[] = ["terminal", "routes", "database", "lineage", "map"];

// Until the backend answers, show every tab (so an older backend without /viewer/instance
// behaves exactly as before).
let info: InstanceInfo = { name: "", project: "", features: ALL, port: null, loaded: false };
const listeners = new Set<() => void>();

function set(next: InstanceInfo) {
  info = next;
  listeners.forEach((l) => l());
}

export async function loadInstance(): Promise<void> {
  try {
    const res = await fetch("/viewer/instance");
    if (!res.ok) return;
    const body = await res.json();
    const features = (body.features as Feature[]).filter((f) => ALL.includes(f));
    set({
      name: String(body.name ?? ""),
      project: String(body.project ?? ""),
      features: features.length ? features : ["terminal"],
      port: typeof body.port === "number" ? body.port : null,
      loaded: true,
    });
  } catch {
    /* backend unreachable: keep defaults */
  }
}

export function useInstance(): InstanceInfo {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => info,
  );
}

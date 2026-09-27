import { useSyncExternalStore } from "react";
import { lineageStore, type LineageSnapshot } from "./lineageStore";

export function useLineage(): LineageSnapshot {
  return useSyncExternalStore(lineageStore.subscribe, lineageStore.getSnapshot);
}

export function useLineageValue<T>(selector: (state: LineageSnapshot) => T): T {
  const snapshot = useLineage();
  return selector(snapshot);
}

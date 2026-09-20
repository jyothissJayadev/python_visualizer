import { useSyncExternalStore } from "react";
import { databaseStore, type DatabaseSnapshot } from "./databaseStore";

export function useDatabase(): DatabaseSnapshot {
  return useSyncExternalStore(databaseStore.subscribe, databaseStore.getSnapshot);
}

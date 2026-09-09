import { useSyncExternalStore } from "react";
import { store, type Snapshot } from "./store";

/** Whole-snapshot subscription. The snapshot is rebuilt (new identity) only
    when something actually changed, so this is cheap enough for this app. */
export function useTerminal(): Snapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

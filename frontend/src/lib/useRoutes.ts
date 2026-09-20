import { useSyncExternalStore } from "react";
import { routesStore, type RoutesSnapshot } from "./routesStore";

/** Whole-snapshot subscription — for components that render most of the state. */
export function useRoutes(): RoutesSnapshot {
  return useSyncExternalStore(routesStore.subscribe, routesStore.getSnapshot);
}

/** Subscribe to one derived value. The component re-renders only when the
    selected value changes (compared with Object.is), not on every store
    update — use this anywhere a component needs just a flag or a count. */
export function useRoutesValue<T>(select: (s: RoutesSnapshot) => T): T {
  return useSyncExternalStore(routesStore.subscribe, () => select(routesStore.getSnapshot()));
}

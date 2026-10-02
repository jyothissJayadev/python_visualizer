import { useEffect, useState } from "react";

export type AppTab = "terminal" | "routes" | "database" | "lineage" | "map";

export interface RouteState {
  tab: AppTab;
  endpointId?: string;
  tableId?: string;
  lineageId?: string;
  focusConnected?: boolean;
}

function parseCurrentRoute(): RouteState {
  if (typeof window === "undefined") {
    return { tab: "terminal" };
  }

  const hash = window.location.hash;
  const [hashPath, hashQuery = ""] = hash.split("?");
  const lower = hashPath.toLowerCase();
  const path = window.location.pathname.toLowerCase();

  const isMap = lower.includes("map") && !lower.includes("lineage");

  const isLineage =
    !isMap &&
    lower.includes("lineage") ||
    lower.includes("e2e") ||
    lower.includes("flow") ||
    path.endsWith("/lineage");

  const isDatabase =
    !isLineage &&
    (lower.includes("database") ||
      lower.includes("schema") ||
      lower.includes("db") ||
      path.endsWith("/database") ||
      path.endsWith("/db"));

  const isRoutes =
    !isLineage &&
    !isDatabase &&
    (lower.includes("routes") ||
      lower.includes("methods") ||
      path.endsWith("/routes") ||
      path.endsWith("/methods"));

  const queryParams = new URLSearchParams(hashQuery || window.location.search);
  const endpointParam = queryParams.get("endpoint");
  const tableParam = queryParams.get("table");
  const lineageParam = queryParams.get("id") || queryParams.get("endpoint") || queryParams.get("lineage");
  const focusParam = queryParams.get("focus");
  const focusConnected =
    focusParam === "connected" || focusParam === "true" || focusParam === "1";

  let tab: AppTab = "terminal";
  if (isMap) {
    tab = "map";
  } else if (isLineage) {
    tab = "lineage";
  } else if (isDatabase) {
    tab = "database";
  } else if (isRoutes) {
    tab = "routes";
  }

  return {
    tab,
    endpointId: endpointParam ?? undefined,
    tableId: tableParam ?? undefined,
    lineageId: lineageParam ?? undefined,
    focusConnected: focusConnected || undefined,
  };
}

export function useAppRouter() {
  const [route, setRoute] = useState<RouteState>(() => parseCurrentRoute());

  useEffect(() => {
    const handleLocationChange = () => {
      setRoute(parseCurrentRoute());
    };

    window.addEventListener("popstate", handleLocationChange);
    window.addEventListener("hashchange", handleLocationChange);

    return () => {
      window.removeEventListener("popstate", handleLocationChange);
      window.removeEventListener("hashchange", handleLocationChange);
    };
  }, []);

  const navigate = (tab: AppTab, id?: string) => {
    let newHash =
      tab === "map"
        ? "#/map"
        : tab === "lineage"
        ? "#/lineage"
        : tab === "database"
          ? "#/database"
          : tab === "routes"
            ? "#/routes"
            : "#/terminal";

    if (id && tab === "lineage") {
      newHash += `?${new URLSearchParams({ id }).toString()}`;
    } else if (id && tab === "routes") {
      newHash += `?${new URLSearchParams({ endpoint: id }).toString()}`;
    } else if (id && tab === "database") {
      newHash += `?${new URLSearchParams({ table: id }).toString()}`;
    }

    if (window.location.hash !== newHash) {
      window.location.hash = newHash;
    }
    setRoute({
      tab,
      endpointId: tab === "routes" ? id : undefined,
      tableId: tab === "database" ? id : undefined,
      lineageId: tab === "lineage" ? id : undefined,
    });
  };

  return {
    tab: route.tab,
    endpointId: route.endpointId,
    tableId: route.tableId,
    lineageId: route.lineageId,
    focusConnected: route.focusConnected,
    navigate,
  };
}


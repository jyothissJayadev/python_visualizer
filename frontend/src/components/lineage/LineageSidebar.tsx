import { lineageStore } from "../../lib/lineageStore";
import { useLineage } from "../../lib/useLineage";

interface Props {
  collapsed: boolean;
  onSelectChain: (id: string) => void;
}

export function LineageSidebar({ collapsed, onSelectChain }: Props) {
  const {
    chains,
    selectedChainId,
    searchQuery,
    filterStatus,
    filterDomain,
    filterApp,
  } = useLineage();

  if (collapsed) return null;

  // Compute unique domains
  const domains = Array.from(new Set(chains.map((c) => c.domain))).sort();

  // Filter chains
  const filteredChains = chains.filter((c) => {
    // Search query filter (search id, path, method, domain, handler, service, route, or component)
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchId = c.id.toLowerCase().includes(q);
      const matchPath = c.path.toLowerCase().includes(q);
      const matchMethod = c.method.toLowerCase().includes(q);
      const matchDomain = c.domain.toLowerCase().includes(q);
      const matchHandler =
        c.endpoint.handler_name.toLowerCase().includes(q) ||
        (c.endpoint.handler_id ? c.endpoint.handler_id.toLowerCase().includes(q) : false);
      const matchService = c.backend.some(
        (b) =>
          b.service.serviceFunc.toLowerCase().includes(q) ||
          b.service.cleanPath.toLowerCase().includes(q) ||
          (b.controller ? b.controller.controllerFunc.toLowerCase().includes(q) : false)
      );
      const matchRoute = c.backend.some((b) =>
        b.routes.some(
          (r) =>
            r.fullPath.toLowerCase().includes(q) ||
            r.method.toLowerCase().includes(q)
        )
      );
      const matchComponent = c.clients.some((cl) =>
        cl.ui.some(
          (u) =>
            u.component.toLowerCase().includes(q) ||
            u.callerFunc.toLowerCase().includes(q)
        )
      );
      if (
        !matchId &&
        !matchPath &&
        !matchMethod &&
        !matchDomain &&
        !matchHandler &&
        !matchService &&
        !matchRoute &&
        !matchComponent
      ) {
        return false;
      }
    }

    // Status filter
    if (filterStatus !== "all" && c.status !== filterStatus) {
      return false;
    }

    // Domain filter
    if (filterDomain !== "all" && c.domain !== filterDomain) {
      return false;
    }

    // App filter
    if (filterApp !== "all") {
      const hasApp = c.clients.some((cl) => cl.app === filterApp);
      if (!hasApp) return false;
    }

    return true;
  });

  return (
    <aside className="lineage-sidebar">
      {/* Filters bar */}
      <div className="lineage-sidebar-filters">
        {/* Endpoint Search Input Box */}
        <div className="lineage-search-box">
          <svg
            className="lineage-search-icon"
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="text"
            className="lineage-search-input"
            placeholder="Search endpoints, paths, handlers..."
            value={searchQuery}
            onChange={(e) => lineageStore.setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                lineageStore.setSearch("");
              }
            }}
          />
          {searchQuery && (
            <button
              type="button"
              className="lineage-clear-search-btn"
              onClick={() => lineageStore.setSearch("")}
              title="Clear search (Esc)"
            >
              ✕
            </button>
          )}
        </div>

        {/* Search match count indicator */}
        {searchQuery.trim() && (
          <div className="lineage-search-count">
            Showing {filteredChains.length} of {chains.length} endpoints
          </div>
        )}

        <div className="filter-pill-row">
          <button
            className={`filter-pill ${filterStatus === "all" ? "active" : ""}`}
            onClick={() => lineageStore.setStatusFilter("all")}
          >
            All ({filteredChains.length < chains.length && !searchQuery.trim() ? `${filteredChains.length}/${chains.length}` : chains.length})
          </button>
          <button
            className={`filter-pill pill-full ${filterStatus === "full_chain" ? "active" : ""}`}
            onClick={() => lineageStore.setStatusFilter("full_chain")}
            title="Flows end-to-end to UI"
          >
            Full Chain
          </button>
          <button
            className={`filter-pill pill-backend ${filterStatus === "backend_exposed" ? "active" : ""}`}
            onClick={() => lineageStore.setStatusFilter("backend_exposed")}
            title="Exposed in Node Express"
          >
            Backend
          </button>
          <button
            className={`filter-pill pill-unexposed ${filterStatus === "unexposed" ? "active" : ""}`}
            onClick={() => lineageStore.setStatusFilter("unexposed")}
            title="Internal to Brain only"
          >
            Internal
          </button>
        </div>

        {/* Domain and App Dropdowns */}
        <div className="lineage-dropdown-row">
          <select
            value={filterDomain}
            onChange={(e) => lineageStore.setDomainFilter(e.target.value)}
            className="lineage-select"
            title="Filter by Brain module domain"
          >
            <option value="all">All Domains ({domains.length})</option>
            {domains.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>

          <select
            value={filterApp}
            onChange={(e) =>
              lineageStore.setAppFilter(
                e.target.value as "all" | "admin" | "frontend"
              )
            }
            className="lineage-select"
            title="Filter by target Client app"
          >
            <option value="all">All Clients</option>
            <option value="admin">Admin App</option>
            <option value="frontend">Frontend App</option>
          </select>
        </div>
      </div>

      {/* Endpoints List */}
      <div className="lineage-chain-list">
        {filteredChains.length === 0 ? (
          <div className="lineage-empty-filter">
            <span>
              {searchQuery.trim()
                ? `No endpoints match "${searchQuery}"`
                : "No endpoints match current filters."}
            </span>
            {searchQuery.trim() && (
              <button
                type="button"
                className="lineage-empty-clear-btn"
                onClick={() => lineageStore.setSearch("")}
              >
                Clear Search
              </button>
            )}
          </div>
        ) : (
          filteredChains.map((chain) => {
            const isSelected = chain.id === selectedChainId;
            const hasBackend = chain.backend.length > 0;
            const hasUi = chain.clients.some((c) => c.ui && c.ui.length > 0);

            return (
              <div
                key={chain.id}
                className={`lineage-chain-item ${isSelected ? "selected" : ""}`}
                onClick={() => onSelectChain(chain.id)}
              >
                <div className="chain-item-header">
                  <span className={`method-tag method-${chain.method.toLowerCase()}`}>
                    {chain.method}
                  </span>
                  <span className="chain-path" title={chain.path}>
                    {chain.path}
                  </span>
                </div>

                <div className="chain-item-meta">
                  <span className="chain-domain">{chain.domain}</span>
                  <span className="chain-handler" title={chain.endpoint.handler_id}>
                    {chain.endpoint.handler_name}
                  </span>

                  {/* 3 Status Indicators: Brain, Node, UI */}
                  <div className="chain-status-dots" title={`Brain: yes | Node: ${hasBackend ? "yes" : "no"} | UI: ${hasUi ? "yes" : "no"}`}>
                    <span className="dot dot-brain" title="Brain endpoint" />
                    <span
                      className={`dot ${hasBackend ? "dot-node" : "dot-dim"}`}
                      title={hasBackend ? "Backend bridge connected" : "Not called in backend"}
                    />
                    <span
                      className={`dot ${hasUi ? "dot-ui" : "dot-dim"}`}
                      title={hasUi ? "UI component connected" : "No UI caller found"}
                    />
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

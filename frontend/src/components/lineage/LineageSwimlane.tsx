import type { LineageChain } from "../../types";
import { lineageStore } from "../../lib/lineageStore";

interface Props {
  chain: LineageChain | null;
}

export function LineageSwimlane({ chain }: Props) {
  if (!chain) {
    return (
      <div className="lineage-empty-selection">
        <div className="empty-icon">🧠 ➔ ⚙️ ➔ 🔌 ➔ 🖥️</div>
        <h3>Select an Endpoint to Inspect End-to-End Lineage</h3>
        <p>
          Pick any Brain endpoint from the sidebar to trace where it is called in
          the Node backend, exposed via Express routes, consumed by Client API
          functions, and triggered inside Frontend/Admin React components.
        </p>
      </div>
    );
  }

  const { endpoint, backend, clients, status } = chain;

  const statusBadges: Record<string, { label: string; cls: string; desc: string }> = {
    full_chain: {
      label: "Full Stack Connected",
      cls: "status-full",
      desc: "Flows end-to-end: Brain → Backend → UI Component",
    },
    client_api: {
      label: "Client API Ready",
      cls: "status-client",
      desc: "Has Backend route & Client API method, awaiting UI integration",
    },
    backend_exposed: {
      label: "Backend Exposed",
      cls: "status-backend",
      desc: "Exposed via Node Express route, no Client API caller found",
    },
    service_only: {
      label: "Internal Service Call",
      cls: "status-service",
      desc: "Called inside Node service, not routed to HTTP API",
    },
    unexposed: {
      label: "Internal Brain Only",
      cls: "status-unexposed",
      desc: "Internal endpoint inside Brain service",
    },
  };

  const currentStatus = statusBadges[status] || {
    label: status,
    cls: "status-unexposed",
    desc: "",
  };

  return (
    <div className="lineage-swimlane-container">
      {/* Chain Status Header Banner */}
      <div className="swimlane-header-banner">
        <div className="banner-left">
          <span className={`chain-status-badge ${currentStatus.cls}`}>
            {currentStatus.label}
          </span>
          <span className="banner-desc">{currentStatus.desc}</span>
        </div>

        <div className="banner-stats">
          <span className="stat-item" title="Backend Services">
            ⚙️ {chain.stats.services_count} Service
          </span>
          <span className="stat-separator">•</span>
          <span className="stat-item" title="Express Routes">
            🛣️ {chain.stats.routes_count} Route
          </span>
          <span className="stat-separator">•</span>
          <span className="stat-item" title="Client APIs">
            🔌 {chain.stats.client_apis_count} Client API
          </span>
          <span className="stat-separator">•</span>
          <span className="stat-item" title="UI Components">
            🖥️ {chain.stats.ui_usages_count} UI Usage
          </span>
        </div>
      </div>

      {/* 4-Column Pipeline Grid */}
      <div className="swimlane-columns-grid">
        {/* ── COLUMN 1: Brain (FastAPI) ── */}
        <div className="swimlane-column col-brain">
          <div className="column-header">
            <span className="col-num">1</span>
            <span className="col-icon">🧠</span>
            <div className="col-title-group">
              <span className="col-title">Brain Service</span>
              <span className="col-subtitle">FastAPI Python Route</span>
            </div>
          </div>

          <div className="column-body">
            <div
              className="lineage-card card-brain"
              onClick={() =>
                lineageStore.selectNodeDetail({
                  type: "brain_endpoint",
                  title: `${endpoint.method} ${endpoint.path}`,
                  subtitle: endpoint.handler_id,
                  file: endpoint.file_path,
                  line: endpoint.line,
                  snippet: endpoint.docstring || endpoint.summary || undefined,
                  data: endpoint,
                })
              }
            >
              <div className="card-top">
                <span className={`method-tag method-${endpoint.method.toLowerCase()}`}>
                  {endpoint.method}
                </span>
                <span className="card-path" title={endpoint.path}>
                  {endpoint.path}
                </span>
              </div>

              <div className="card-item-title">
                <span className="fn-icon">ƒ</span>
                <span className="fn-name">{endpoint.handler_name}</span>
              </div>

              {endpoint.summary && (
                <p className="card-summary" title={endpoint.summary}>
                  {endpoint.summary}
                </p>
              )}

              <div className="card-footer">
                <span className="file-badge">
                  {endpoint.file_path}:{endpoint.line}
                </span>
                {endpoint.tags && endpoint.tags.length > 0 && (
                  <span className="tag-badge">{endpoint.tags[0]}</span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── COLUMN 2: Backend Bridge (Node.js/Express) ── */}
        <div className="swimlane-column col-backend">
          <div className="column-header">
            <span className="col-num">2</span>
            <span className="col-icon">⚙️</span>
            <div className="col-title-group">
              <span className="col-title">Backend Bridge</span>
              <span className="col-subtitle">Node.js Service → Controller → Express Route</span>
            </div>
          </div>

          <div className="column-body">
            {backend.length === 0 ? (
              <div className="column-empty">
                <span className="empty-sub">Not called in Node backend</span>
                <p>This endpoint is only used internally within Brain.</p>
              </div>
            ) : (
              backend.map((b, idx) => (
                <div key={idx} className="bridge-group">
                  {/* Service Card */}
                  <div
                    className="lineage-card card-service"
                    onClick={() =>
                      lineageStore.selectNodeDetail({
                        type: "backend_service",
                        title: `Service: ${b.service.serviceFunc}`,
                        subtitle: `Calls ${b.service.method} ${b.service.cleanPath}`,
                        file: `apps/backend/${b.service.file}`,
                        line: b.service.line,
                        snippet: `// In apps/backend/${b.service.file}:${b.service.line}\ncallBrain('${b.service.rawPath}')`,
                        data: b.service,
                      })
                    }
                  >
                    <div className="card-step-label">1. Client Service Method</div>
                    <div className="card-item-title">
                      <span className="fn-icon">⚙️</span>
                      <span className="fn-name">{b.service.serviceFunc}</span>
                    </div>
                    <div className="card-target-url" title={b.service.rawPath}>
                      <span>calls ➔ </span>
                      <code>{b.service.rawPath}</code>
                    </div>
                    <div className="card-footer">
                      <span className="file-badge">
                        {b.service.file}:{b.service.line}
                      </span>
                    </div>
                  </div>

                  {/* Controller Card */}
                  {b.controller ? (
                    <div
                      className="lineage-card card-controller"
                      onClick={() =>
                        lineageStore.selectNodeDetail({
                          type: "backend_controller",
                          title: `Controller: ${b.controller!.controllerFunc}`,
                          subtitle: `Handles HTTP request for ${b.service.serviceFunc}`,
                          file: `apps/backend/${b.controller!.file}`,
                          line: b.controller!.line,
                          data: b.controller,
                        })
                      }
                    >
                      <div className="card-step-label">2. Controller Handler</div>
                      <div className="card-item-title">
                        <span className="fn-icon">🎮</span>
                        <span className="fn-name">{b.controller.controllerFunc}</span>
                      </div>
                      <div className="card-footer">
                        <span className="file-badge">
                          {b.controller.file}:{b.controller.line}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="card-missing">No controller handler mapped</div>
                  )}

                  {/* Express Routes Cards */}
                  {b.routes.length > 0 ? (
                    b.routes.map((r, rIdx) => (
                      <div
                        key={rIdx}
                        className="lineage-card card-route"
                        onClick={() =>
                          lineageStore.selectNodeDetail({
                            type: "backend_route",
                            title: `Express Route: ${r.method} ${r.fullPath}`,
                            subtitle: `Mount point: ${r.file}`,
                            file: `apps/backend/${r.file}`,
                            line: r.line,
                            snippet: `router.${r.method.toLowerCase()}('${r.subPath}', ...)`,
                            data: r,
                          })
                        }
                      >
                        <div className="card-step-label">3. Express Endpoint</div>
                        <div className="card-top">
                          <span className={`method-tag method-${r.method.toLowerCase()}`}>
                            {r.method}
                          </span>
                          <span className="card-path" title={r.fullPath}>
                            {r.fullPath}
                          </span>
                        </div>
                        <div className="card-footer">
                          <span className="file-badge">
                            {r.file}:{r.line}
                          </span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="card-missing">Not mounted on Express router</div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── COLUMN 3: Client API Layer (Frontend & Admin) ── */}
        <div className="swimlane-column col-client-api">
          <div className="column-header">
            <span className="col-num">3</span>
            <span className="col-icon">🔌</span>
            <div className="col-title-group">
              <span className="col-title">Client API Layer</span>
              <span className="col-subtitle">Frontend & Admin HTTP Client Methods</span>
            </div>
          </div>

          <div className="column-body">
            {clients.length === 0 ? (
              <div className="column-empty">
                <span className="empty-sub">No Client API callers</span>
                <p>No client-side API helper is invoking this backend route.</p>
              </div>
            ) : (
              clients.map((c, cIdx) => (
                <div
                  key={cIdx}
                  className="lineage-card card-client-api"
                  onClick={() =>
                    lineageStore.selectNodeDetail({
                      type: "client_api",
                      title: `${c.app.toUpperCase()} API: ${c.api.apiFunc}`,
                      subtitle: `${c.api.method} ${c.api.url}`,
                      file: `apps/${c.app}/src/${c.api.file}`,
                      line: c.api.line,
                      snippet: `// In apps/${c.app}/src/${c.api.file}:${c.api.line}\nexport const ${c.api.apiFunc} = ...`,
                      data: c.api,
                    })
                  }
                >
                  <div className="card-top">
                    <span className={`app-badge app-${c.app}`}>
                      {c.app === "admin" ? "Admin" : "Frontend"}
                    </span>
                    <span className={`method-tag method-${c.api.method.toLowerCase()}`}>
                      {c.api.method}
                    </span>
                  </div>

                  <div className="card-item-title">
                    <span className="fn-icon">⚡</span>
                    <span className="fn-name">{c.api.apiFunc}</span>
                  </div>

                  <div className="card-target-url" title={c.api.url}>
                    <code>{c.api.url}</code>
                  </div>

                  <div className="card-footer">
                    <span className="file-badge">
                      {c.api.file}:{c.api.line}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── COLUMN 4: UI Component & Trigger (React) ── */}
        <div className="swimlane-column col-ui">
          <div className="column-header">
            <span className="col-num">4</span>
            <span className="col-icon">🖥️</span>
            <div className="col-title-group">
              <span className="col-title">UI Component & Trigger</span>
              <span className="col-subtitle">React Components, Hooks & Handlers</span>
            </div>
          </div>

          <div className="column-body">
            {clients.every((c) => !c.ui || c.ui.length === 0) ? (
              <div className="column-empty">
                <span className="empty-sub">No UI trigger found</span>
                <p>API is defined, but no component is calling it yet.</p>
              </div>
            ) : (
              clients.flatMap((c) => c.ui || []).map((u, uIdx) => (
                <div
                  key={uIdx}
                  className="lineage-card card-ui"
                  onClick={() =>
                    lineageStore.selectNodeDetail({
                      type: "client_ui",
                      title: `${u.component} (${u.callerFunc})`,
                      subtitle: `Calls ${u.apiFunc} in ${u.app}`,
                      file: `apps/${u.app}/src/${u.file}`,
                      line: u.line,
                      snippet: u.snippet,
                      data: u,
                    })
                  }
                >
                  <div className="card-top">
                    <span className={`app-badge app-${u.app}`}>
                      {u.app === "admin" ? "Admin" : "Frontend"}
                    </span>
                    <span className="card-component-name">{u.component}</span>
                  </div>

                  <div className="card-item-title">
                    <span className="fn-icon">🎯</span>
                    <span className="fn-name">{u.callerFunc}</span>
                  </div>

                  {u.snippet && (
                    <pre className="card-snippet-preview">
                      <code>{u.snippet}</code>
                    </pre>
                  )}

                  <div className="card-footer">
                    <span className="file-badge">
                      {u.file}:{u.line}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

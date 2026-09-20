import { useMemo } from "react";
import { routesStore } from "../../lib/routesStore";
import { useRoutes } from "../../lib/useRoutes";
import { HTTP_METHODS, methodClass, pathParts, timeAgo } from "../../lib/routesUi";
import type { EndpointSummary } from "../../lib/routesApi";

interface Props {
  collapsed: boolean;
  onSelect: (id: string) => void;
}

function matchesSearch(e: EndpointSummary, needle: string): boolean {
  return `${e.method} ${e.path} ${e.handler_name} ${e.handler_id} ${e.summary ?? ""} ${e.tags.join(" ")}`
    .toLowerCase()
    .includes(needle);
}

export function EndpointSidebar({ collapsed, onSelect }: Props) {
  const s = useRoutes();
  const needle = s.sidebarSearch.trim().toLowerCase();
  const filtering = needle.length > 0 || s.methodFilter.size > 0;

  const groups = useMemo(() => {
    if (!s.listing) return [];
    return s.listing.groups
      .map((g) => ({
        ...g,
        endpoints: g.endpoints.filter(
          (e) => (s.methodFilter.size === 0 || s.methodFilter.has(e.method)) && (!needle || matchesSearch(e, needle)),
        ),
      }))
      .filter((g) => g.endpoints.length > 0);
  }, [s.listing, needle, s.methodFilter]);

  const total = s.listing?.groups.reduce((n, g) => n + g.count, 0) ?? 0;
  const shown = groups.reduce((n, g) => n + g.endpoints.length, 0);
  const a = s.analysis;
  const warnings = (s.listing?.unmounted.length ?? 0) + (s.listing?.errors.length ?? 0);

  if (collapsed) return null;

  return (
    <aside className="rt-sidebar">
      <div className="rt-sidebar-head">
        <div className="rt-sidebar-title">
          Endpoints <span className="rt-count-pill">{filtering ? `${shown}/${total}` : total}</span>
        </div>
        <input
          className="rt-input"
          placeholder="Search path, handler, tag…"
          value={s.sidebarSearch}
          onChange={(e) => routesStore.setSidebarSearch(e.target.value)}
        />
        <div className="rt-method-filters">
          {HTTP_METHODS.map((m) => (
            <button
              key={m}
              className={"rt-mfilter " + methodClass(m) + (s.methodFilter.has(m) ? " on" : "")}
              onClick={() => routesStore.toggleMethod(m)}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      <div className="rt-sidebar-list">
        {s.listingError && <div className="rt-empty warn">Backend unreachable: {s.listingError}</div>}
        {!s.listing && !s.listingError && <div className="rt-empty">Loading…</div>}
        {a?.status === "error" && (
          <div className="rt-empty warn">
            <b>Analysis failed</b>
            <div className="rt-empty-detail">{a.error}</div>
            <div className="rt-empty-detail">Restart the backend with the correct <code>--project</code> path.</div>
          </div>
        )}
        {s.listing && !a?.ready && a?.status !== "error" && shown === 0 && (
          <div className="rt-empty"><span className="rt-spinner" /> Analyzing the project…</div>
        )}
        {s.listing && a?.ready && a.status !== "error" && shown === 0 && (
          <div className="rt-empty">
            {total === 0 ? (
              <>No endpoints found in<div className="rt-empty-detail"><code>{a.project_path}</code></div></>
            ) : "No endpoints match."}
          </div>
        )}

        {groups.map((g) => {
          const open = filtering || !s.collapsedGroups.has(g.prefix);
          return (
            <div key={g.prefix} className="rt-group">
              <button className="rt-group-head" onClick={() => routesStore.toggleGroup(g.prefix)}>
                <span className={"rt-chevron" + (open ? " open" : "")}>▸</span>
                <span className="rt-group-name">{g.prefix}</span>
                <span className="rt-count-pill">{g.endpoints.length}</span>
              </button>
              {open && g.endpoints.map((e) => (
                <button
                  key={e.id}
                  className={"rt-ep" + (s.selectedId === e.id ? " active" : "")}
                  onClick={() => onSelect(e.id)}
                  title={`${e.handler_id}\n${e.file_path}:${e.line}`}
                >
                  <span className={"rt-method " + methodClass(e.method)}>{e.method}</span>
                  <span className="rt-ep-main">
                    <span className="rt-path">
                      {pathParts(e.path.startsWith(g.prefix) ? e.path.slice(g.prefix.length) || "/" : e.path).map((p, i) => (
                        <span key={i} className={p.param ? "param" : ""}>{p.text}</span>
                      ))}
                    </span>
                    <span className="rt-ep-sub">
                      {e.handler_name}
                      {e.factory && <span className="rt-mini" title="Built by a router factory">factory</span>}
                      {e.conditional && <span className="rt-mini warn" title="Conditionally registered">cond</span>}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          );
        })}
      </div>

      <div className="rt-sidebar-foot" title={a?.project_path}>
        <span className={"rt-dot " + (a?.status === "scanning" || s.rescanning ? "scanning" : a?.status === "error" ? "error" : a?.ready ? "ok" : "")} />
        <span className="rt-foot-text">
          {a?.status === "scanning" || s.rescanning
            ? "Analyzing…"
            : a?.status === "error"
              ? `Analysis failed: ${a.error}`
              : a?.ready
                ? `Analyzed ${timeAgo(a.analyzed_at)} · ${a.duration_ms} ms`
                : a?.from_cache ? "Showing cached routes…" : "Waiting for analysis…"}
        </span>
        {warnings > 0 && (
          <span
            className="rt-mini warn"
            title={[
              ...(s.listing?.unmounted.map((u) => `unmounted router ${u.id} (${u.route_count} routes)`) ?? []),
              ...(s.listing?.errors ?? []),
            ].join("\n")}
          >
            {warnings} warning{warnings > 1 ? "s" : ""}
          </span>
        )}
      </div>
    </aside>
  );
}

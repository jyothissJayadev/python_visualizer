import { useEffect, useState } from "react";
import { MAX_DEPTH, routesStore } from "../../lib/routesStore";
import { useRoutes } from "../../lib/useRoutes";
import { methodClass, pathParts, timeAgo } from "../../lib/routesUi";

const DEPTHS = [2, 4, 6, 8];

/** Debounced, so typing does not re-render the whole tree on every keystroke.
    Keyed by the selected endpoint by the parent: switching endpoints resets it. */
function TreeSearchBox() {
  const s = useRoutes();
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => routesStore.setTreeSearch(query), 180);
    return () => clearTimeout(t);
  }, [query]);
  return (
    <div className="rt-search">
    <input
      className="rt-input"
      placeholder="Find a function…"
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") routesStore.stepSearch(e.shiftKey ? -1 : 1); }}
    />
    {s.treeSearch.trim().length >= 2 && (
      <span className="rt-search-count">
        {s.searchHits.length ? `${s.searchIndex + 1}/${s.searchHits.length}` : "0"}
        <button onClick={() => routesStore.stepSearch(-1)} disabled={!s.searchHits.length}>↑</button>
        <button onClick={() => routesStore.stepSearch(1)} disabled={!s.searchHits.length}>↓</button>
      </span>
    )}
  </div>
  );
}

export function EndpointHeader() {
  const s = useRoutes();
  const ep = s.endpoint;
  const tree = s.tree;
  const stats = tree?.stats;
  const pct = stats ? Math.round(stats.coverage * 100) : 0;
  const rt = s.runtime;
  const handlerArmed = ep && rt ? rt.armed[ep.handler_id] : undefined;
  const lastReq = rt?.requests[0];

  const libCalls = stats ? stats.external + stats.class : 0;

  return (
    <header className="rt-header">
      <div className="rt-header-top">
        {ep ? (
          <>
            <span className={"rt-method big " + methodClass(ep.method)}>{ep.method}</span>
            <h2 className="rt-path big">
              {pathParts(ep.path).map((p, i) => <span key={i} className={p.param ? "param" : ""}>{p.text}</span>)}
            </h2>
            <span className="rt-handler" title={ep.handler_id}>{ep.handler_name}()</span>
          </>
        ) : (
          <h2 className="rt-path big muted">{s.selectedId ?? "No endpoint selected"}</h2>
        )}
        <span className="rt-spacer" />
        <div className="rt-seg" role="tablist" aria-label="View">
          <button role="tab" aria-selected={s.view === "tree"} className={s.view === "tree" ? "on" : ""} onClick={() => routesStore.setView("tree")}>Hierarchy</button>
          <button role="tab" aria-selected={s.view === "graph"} className={s.view === "graph" ? "on" : ""} onClick={() => routesStore.setView("graph")}>Graph</button>
          <button role="tab" aria-selected={s.view === "data"} className={s.view === "data" ? "on" : ""} onClick={() => routesStore.setView("data")}>
            Data{s.data ? <span className="rt-seg-count">{s.data.tables.length}</span> : null}
          </button>
        </div>
        <button
          type="button"
          className={`rt-drawer-toggle ${s.drawerOpen ? "on" : ""}`}
          onClick={() => routesStore.toggleDrawer()}
          title={s.drawerOpen ? "Close details panel (Esc)" : "Open details panel"}
          aria-label={s.drawerOpen ? "Close details panel" : "Open details panel"}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="15" y1="3" x2="15" y2="21" />
          </svg>
          <span>{s.drawerOpen ? "Hide Details" : "Details"}</span>
        </button>
      </div>

      {stats && (
        <div className="rt-stats">
          <span className="rt-stat"><b>{stats.function}</b> functions</span>
          <span className="rt-stat"><b>{stats.max_depth}</b> levels deep</span>
          {s.data && <span className="rt-stat"><b>{s.data.tables.length}</b> tables</span>}
          {s.data && s.data.audit.unmatched.length > 0 && (
            <span
              className="rt-stat warn"
              title={`${s.data.audit.unmatched.length} database call(s) could not be tied to a table — open the Data view to see which`}
            >
              ⚠ {s.data.audit.unmatched.length} unmatched DB call{s.data.audit.unmatched.length > 1 ? "s" : ""}
            </span>
          )}
          <span className="rt-stat" title="Library and built-in calls are listed in the details panel of the function that makes them">
            <b>{libCalls}</b> library calls
          </span>
          <span className="rt-stat cov" title={`${stats.unresolved} calls could not be resolved statically`}>
            <span className="rt-cov-bar"><span style={{ width: `${pct}%` }} className={pct < 80 ? "low" : ""} /></span>
            <b>{pct}%</b> resolved
          </span>
        </div>
      )}

      {ep && (
        <div className="rt-runtime-bar">
          <span className="rt-label">Runtime</span>
          {rt && rt.request_count > 0 ? (
            <span className="rt-run-pill live">
              <i />
              <b>{rt.request_count}</b> request{rt.request_count > 1 ? "s" : ""} observed · {rt.span_count} calls
              {lastReq?.ts ? ` · last ${timeAgo(lastReq.ts)}` : ""}
              {lastReq?.status ? ` · HTTP ${lastReq.status}` : ""}
            </span>
          ) : (
            <span className="rt-run-pill">
              {handlerArmed === undefined
                ? "No runtime data — arm this endpoint, then send a request to brain"
                : "Armed — waiting for a request to this endpoint"}
            </span>
          )}
          <span className="rt-spacer" />
          {rt && !rt.brain_connected && <span className="rt-mini warn" title="Brain has not registered with the collector yet">brain not connected</span>}
          {s.brainCode?.state === "older" && (
            <span
              className="rt-mini warn"
              title={`${s.brainCode.newer_files} source file(s) changed after brain started` +
                (s.brainCode.newest_file ? `, most recently ${s.brainCode.newest_file}` : "") +
                ". The hierarchy shows the code on disk; live traces come from the older running code. Restart brain (or run it with --reload)."}
            >
              ⚠ brain is running older code · {s.brainCode.newer_files} file{s.brainCode.newer_files > 1 ? "s" : ""} changed
            </span>
          )}
          <label className="rt-check" title="Fade functions that were not seen at runtime (only armed functions are traced)">
            <input type="checkbox" checked={s.dimUnobserved} onChange={(e) => routesStore.setDimUnobserved(e.target.checked)} />
            Dim unobserved
          </label>
          <button
            className={"rt-btn" + (handlerArmed !== undefined ? " armed" : "")}
            disabled={s.arming}
            onClick={() => void routesStore.arm(handlerArmed === undefined)}
            title={handlerArmed === undefined
              ? "Arm the handler in brain (deep): records every call under it while it runs"
              : "Stop tracing this endpoint's handler"}
          >
            {s.arming ? "…" : handlerArmed === undefined ? "Arm & trace" : handlerArmed ? "Armed · deep ✕" : "Armed ✕"}
          </button>
        </div>
      )}

      {s.view !== "data" && (
      <div className="rt-toolbar">
        <TreeSearchBox key={s.selectedId} />

        <div className="rt-expand">
          <span className="rt-label">Expand to</span>
          {DEPTHS.map((d) => (
            <button key={d} className="rt-btn sm" onClick={() => void routesStore.expandLevels(d)} disabled={!tree}>{d}</button>
          ))}
          <button
            className="rt-btn sm"
            onClick={() => void routesStore.expandLevels(MAX_DEPTH)}
            disabled={!tree}
            title={stats ? `Loads up to ${MAX_DEPTH} levels (${stats.function.toLocaleString()} functions in total)` : ""}
          >
            all
          </button>
          <button className="rt-btn sm" onClick={() => routesStore.collapseAll()} disabled={!tree}>Collapse</button>
        </div>
      </div>
      )}
    </header>
  );
}

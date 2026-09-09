import { store } from "../lib/store";
import { useTerminal } from "../lib/useTerminal";

interface Props {
  catalogCollapsed: boolean;
  onToggleCatalog: () => void;
  onSendTest: () => void;
}

export function Toolbar({
  catalogCollapsed,
  onToggleCatalog,
  onSendTest,
}: Props) {
  const s = useTerminal();

  return (
    <header className="app-toolbar">
      <div className="toolbar-left">
        <button
          className={"btn-icon" + (catalogCollapsed ? "" : " active")}
          title="Toggle Function Catalog Rail"
          onClick={onToggleCatalog}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 3h18v18H3zM9 3v18" />
          </svg>
        </button>

        <div className="app-brand">
          <span className="brain-icon">🧠</span>
          <span>Brain Terminal</span>
          <span className="brand-tag">v2.0-fastapi</span>
        </div>

        <div className="toolbar-actions">
          <button className="btn-sm" title="Clear Stream" onClick={() => store.clearStream()}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            Clear
          </button>

          <button
            className={"btn-sm" + (s.paused ? " active" : "")}
            title="Pause or Resume Stream"
            onClick={() => store.togglePause()}
          >
            <span>{s.paused ? "▶" : "⏸"}</span>
            <span>{s.paused ? "Resume" : "Pause"}</span>
          </button>

          <div
            className="verbosity-segmented"
            title="Show only the exact functions you armed, or also every nested (deep-mode) call underneath them"
          >
            <button
              className={"verbosity-btn" + (s.verbosity === "selected" ? " active" : "")}
              onClick={() => store.setVerbosity("selected")}
            >
              Armed only
            </button>
            <button
              className={"verbosity-btn" + (s.verbosity === "all" ? " active" : "")}
              onClick={() => store.setVerbosity("all")}
            >
              + nested
            </button>
          </div>

          <button
            className={"btn-sm" + (s.loopFold ? " active" : "")}
            title="Fold runs of 10+ identical sibling calls into one row; click the row to expand every iteration"
            onClick={() => store.toggleLoopFold()}
          >
            <span>↻</span> Fold loops
          </button>

          <button
            className={"btn-sm" + (s.collapsedSpanIds.size > 0 ? " active" : "")}
            title={
              s.collapsedSpanIds.size > 0
                ? "Expand all inner deep calls across all traces"
                : "Collapse all inner deep calls under parent functions"
            }
            onClick={() => {
              if (s.collapsedSpanIds.size > 0) {
                store.expandAllDeepSpans();
              } else {
                store.collapseAllDeepSpans();
              }
            }}
          >
            <span>{s.collapsedSpanIds.size > 0 ? "▸" : "▾"}</span>
            <span>{s.collapsedSpanIds.size > 0 ? "Expand inner" : "Collapse inner"}</span>
          </button>

          <button
            className={"btn-sm" + (s.selectedOnly ? " active" : "")}
            title="Show only requests where an armed function ran, and inside them only the armed calls and their nested calls — everything else is hidden"
            onClick={() => store.toggleSelectedOnly()}
          >
            <span>≡</span> {s.selectedOnly ? "Focus armed" : "Show all requests"}
          </button>

          <div className="search-filter-box">
            <svg className="search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              type="text"
              placeholder="Filter request_id or text..."
              value={s.filterQuery}
              onChange={(e) => store.setFilterQuery(e.target.value)}
            />
          </div>

          <button className="btn-sm" title="Send Test Request" onClick={onSendTest}>
            <span style={{ color: "var(--accent-cyan)" }}>⚡</span> Send Test
          </button>
        </div>
      </div>

      <div className="toolbar-right">
        <div className="status-pill" title="WebSocket Connection Status">
          <span
            className={
              "status-dot " +
              (s.connection === "connected"
                ? "connected"
                : s.connection === "reconnecting"
                  ? "reconnecting"
                  : "")
            }
          />
          <span>{s.connectionLabel}</span>
        </div>
      </div>
    </header>
  );
}

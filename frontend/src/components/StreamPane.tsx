import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { store } from "../lib/store";
import { useTerminal } from "../lib/useTerminal";
import {
  formatDuration,
  formatTimestamp,
  getFunctionTrackInfo,
} from "../lib/format";
import { StreamRowSwitch } from "./StreamRows";

export function StreamPane() {
  const s = useTerminal();
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const visibleRequests = useMemo(
    () => s.requests.filter((r) => r.visible),
    [s.requests],
  );

  const totalMainCalls = useMemo(() => {
    let count = 0;
    for (const r of visibleRequests) {
      for (const row of r.rows) {
        if (row.rowKind !== "log") {
          const sp = s.spans.get(row.spanId);
          if (sp && getFunctionTrackInfo(sp, s).isMain) {
            count++;
          }
        }
      }
    }
    return count;
  }, [visibleRequests, s]);

  const hasContent = visibleRequests.some(
    (r) => r.startEvent || r.rows.length > 0,
  );

  // Auto-scroll to bottom on new content.
  useLayoutEffect(() => {
    if (s.autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [s.version, s.autoScroll]);

  useEffect(() => {
    const c = scrollRef.current;
    if (!c) return;
    const onScroll = () => {
      const atBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 40;
      store.setAutoScroll(atBottom);
    };
    c.addEventListener("scroll", onScroll);
    return () => c.removeEventListener("scroll", onScroll);
  }, []);

  // Keyboard shortcut Ctrl+F / Cmd+F to focus function search inside trace
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Scroll active search hit into view
  const currentHitSpanId =
    s.traceFnSearchHits.length > 0
      ? s.traceFnSearchHits[s.traceFnSearchIndex]
      : null;

  useEffect(() => {
    if (!currentHitSpanId) return;
    const el = document.getElementById(`trace-span-${currentHitSpanId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [currentHitSpanId, s.traceFnSearchIndex]);

  return (
    <main className="stream-pane">
      <div className="stream-header-bar">
        <div className="stream-header-info">
          <span>LIVE TRACE STREAM</span>
          <span
            style={{
              color:
                s.activeRequests > 0
                  ? "var(--accent-amber)"
                  : "var(--accent-emerald)",
            }}
          >
            ● {s.activeRequests} active
          </span>
          <span>{s.totalEvents} events</span>
          {totalMainCalls > 0 && (
            <span
              className="stream-header-target-stat"
              title="Total instrumented main function calls in current trace stream"
            >
              🎯 {totalMainCalls} main {totalMainCalls === 1 ? "call" : "calls"}
            </span>
          )}
        </div>

        {/* Function Search inside Trace Stream */}
        <div className="trace-fn-search-wrapper">
          <div className="trace-fn-search-box">
            <svg
              className="trace-search-icon"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              ref={searchInputRef}
              type="text"
              className="trace-fn-search-input"
              placeholder="Search function in trace… (↵ / ⇧↵)"
              value={s.traceFnSearch}
              onChange={(e) => store.setTraceFnSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  store.stepTraceFnSearch(e.shiftKey ? -1 : 1);
                } else if (e.key === "Escape") {
                  store.setTraceFnSearch("");
                }
              }}
            />
            {s.traceFnSearch.trim() && (
              <div className="trace-fn-search-controls">
                <span className="trace-fn-search-count">
                  {s.traceFnSearchHits.length > 0
                    ? `${s.traceFnSearchIndex + 1}/${s.traceFnSearchHits.length}`
                    : "0"}
                </span>
                <button
                  type="button"
                  className="trace-search-btn"
                  title="Previous matching function (Shift+Enter)"
                  disabled={s.traceFnSearchHits.length === 0}
                  onClick={() => store.stepTraceFnSearch(-1)}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="trace-search-btn"
                  title="Next matching function (Enter)"
                  disabled={s.traceFnSearchHits.length === 0}
                  onClick={() => store.stepTraceFnSearch(1)}
                >
                  ▼
                </button>
                <button
                  type="button"
                  className="trace-search-clear"
                  title="Clear function search (Esc)"
                  onClick={() => store.setTraceFnSearch("")}
                >
                  ✕
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className={"trace-fn-filter-toggle" + (s.traceFnFilterOnly ? " active" : "")}
            title={
              s.traceFnFilterOnly
                ? "Filter mode ON: showing only matching functions (click to show all with highlight)"
                : "Filter mode OFF: showing all functions with highlight (click to filter stream)"
            }
            onClick={() => store.setTraceFnFilterOnly(!s.traceFnFilterOnly)}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
            </svg>
            <span>{s.traceFnFilterOnly ? "Filtered" : "Filter"}</span>
          </button>
        </div>

        <div className="stream-header-actions">
          <span
            style={{
              color: s.autoScroll ? "var(--accent-cyan)" : "var(--accent-amber)",
              fontSize: 10.5,
              cursor: "pointer",
            }}
            onClick={() => store.setAutoScroll(!s.autoScroll)}
            title="Click to toggle auto-scroll"
          >
            Auto-scroll: {s.autoScroll ? "ON" : "PAUSED"}
          </span>
        </div>
      </div>

      <div className="stream-scroll-container" ref={scrollRef}>
        {!hasContent && s.traceFnFilterOnly && s.traceFnSearch.trim() ? (
          <div className="stream-empty-state">
            <div className="empty-icon">🔍</div>
            <h3>No functions matching "{s.traceFnSearch}"</h3>
            <p>
              No function call in the current trace stream matched your search query.
            </p>
            <button
              className="btn-sm"
              style={{ marginTop: 8 }}
              onClick={() => {
                store.setTraceFnFilterOnly(false);
                store.setTraceFnSearch("");
              }}
            >
              Reset function search
            </button>
          </div>
        ) : !hasContent && (
          <div className="stream-empty-state">
            <div className="empty-icon">⚡</div>
            <h3>Waiting for backend traces...</h3>
            <p>
              Connected to the FastAPI streaming WebSocket. Make HTTP requests to
              the backend to watch execution flow in real-time.
            </p>
          </div>
        )}

        <div>
          {visibleRequests.map((r) => {
            const method = r.startEvent?.data?.method || "POST";
            const path = r.startEvent?.data?.path || "/";
            const summary = r.startEvent?.data?.summary;
            const status = r.endEvent?.data?.status ?? 200;
            const durationMs = r.endEvent?.data?.duration_ms || 0;
            const hasTarget = r.rows.some((row) => {
              if (row.rowKind === "log") return false;
              const sp = s.spans.get(row.spanId);
              return sp ? getFunctionTrackInfo(sp, s).isMain : false;
            });

            return (
              <div
                key={r.id}
                className={"stream-group" + (hasTarget ? " has-target-fn" : "")}
                style={{ borderLeftColor: r.color }}
              >
                {r.startEvent && (
                  <div className="req-start-row">
                    <div className="req-start-left">
                      <span className={`req-method method-${method}`}>
                        {method}
                      </span>
                      <span className="req-path">{path}</span>
                      {summary && (
                        <span className="req-summary">· {summary}</span>
                      )}
                      {hasTarget && (
                        <span
                          className="badge badge-target-sm"
                          title="This request executed a tracked main function"
                        >
                          🎯 MAIN ACTIVE
                        </span>
                      )}
                    </div>
                    <div className="req-start-right">
                      {!r.endEvent && <span className="spinner-icon" />}
                      <span style={{ color: "var(--text-muted)" }}>
                        {formatTimestamp(r.startEvent.ts)}
                      </span>
                    </div>
                  </div>
                )}

                <div className="req-entries-container">
                  {r.rows.map((row) => (
                    <StreamRowSwitch
                      key={
                        row.rowKind === "log"
                          ? row.key
                          : row.rowKind === "loop"
                            ? "loop-" + row.key
                            : row.rowKind + "-" + row.spanId
                      }
                      row={row}
                      snap={s}
                    />
                  ))}
                </div>

                {r.endEvent && (
                  <div className="req-end-row">
                    <span
                      className={
                        "badge " + (status >= 400 ? "badge-slow" : "badge-fast")
                      }
                    >
                      {status} OK
                    </span>
                    <span className="badge badge-dim">
                      {formatDuration(durationMs)}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {!s.autoScroll && s.unread > 0 && (
        <button
          className="jump-latest-pill"
          onClick={() => store.catchUp()}
        >
          <span>↓ Jump to latest</span>
          <span
            className="badge badge-dim"
            style={{ background: "rgba(0,0,0,0.4)", color: "#fff" }}
          >
            {s.unread}
          </span>
        </button>
      )}
    </main>
  );
}

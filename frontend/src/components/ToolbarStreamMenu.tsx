import { useEffect, useRef, useState } from "react";
import { store } from "../lib/store";
import { useTerminal } from "../lib/useTerminal";

export function ToolbarStreamMenu() {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const s = useTerminal();

  // Close on outside click or Escape key
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Count active non-default stream settings
  const activeCount =
    (s.paused ? 1 : 0) +
    (s.loopFold ? 1 : 0) +
    (s.collapsedSpanIds.size > 0 ? 1 : 0) +
    (s.selectedOnly ? 1 : 0);

  return (
    <div className="toolbar-menu-wrapper" ref={menuRef}>
      <button
        type="button"
        className={
          "btn-sm toolbar-kebab-btn" +
          (open ? " active" : "") +
          (activeCount > 0 ? " has-active" : "")
        }
        title="Stream options (Clear, Pause, Fold loops, Collapse, Focus)"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="true"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="2.2" />
          <circle cx="12" cy="12" r="2.2" />
          <circle cx="12" cy="19" r="2.2" />
        </svg>
        {activeCount > 0 && (
          <span
            className="menu-active-dot"
            title={`${activeCount} active filter / view setting${activeCount > 1 ? "s" : ""}`}
          />
        )}
      </button>

      {open && (
        <div className="toolbar-dropdown-menu" role="menu">
          {/* Section: Stream Control */}
          <div className="dropdown-section-label">Stream Controls</div>

          {/* Pause / Resume */}
          <button
            type="button"
            className={"dropdown-item" + (s.paused ? " item-warning" : "")}
            onClick={() => store.togglePause()}
          >
            <span className="dropdown-item-icon">{s.paused ? "▶" : "⏸"}</span>
            <div className="dropdown-item-text">
              <span className="dropdown-item-title">
                {s.paused ? "Resume Stream" : "Pause Stream"}
              </span>
              <span className="dropdown-item-sub">
                {s.paused ? "Stream paused (buffering)" : "Live real-time streaming"}
              </span>
            </div>
            <span className={"dropdown-badge " + (s.paused ? "badge-paused" : "badge-live")}>
              {s.paused ? "PAUSED" : "LIVE"}
            </span>
          </button>

          {/* Clear Stream */}
          <button
            type="button"
            className="dropdown-item"
            onClick={() => {
              store.clearStream();
              setOpen(false);
            }}
          >
            <span className="dropdown-item-icon">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </span>
            <div className="dropdown-item-text">
              <span className="dropdown-item-title">Clear Stream</span>
              <span className="dropdown-item-sub">Wipe telemetry requests & logs</span>
            </div>
          </button>

          <div className="dropdown-divider" />

          {/* Section: View & Folding */}
          <div className="dropdown-section-label">View & Folding</div>

          {/* Fold loops */}
          <button
            type="button"
            className={"dropdown-item" + (s.loopFold ? " active" : "")}
            onClick={() => store.toggleLoopFold()}
          >
            <span className="dropdown-item-icon">↻</span>
            <div className="dropdown-item-text">
              <span className="dropdown-item-title">Fold Loops</span>
              <span className="dropdown-item-sub">Fold 10+ repeated sibling calls</span>
            </div>
            <span className={"dropdown-switch" + (s.loopFold ? " on" : "")} />
          </button>

          {/* Collapse / Expand Inner */}
          <button
            type="button"
            className={"dropdown-item" + (s.collapsedSpanIds.size > 0 ? " active" : "")}
            onClick={() => {
              if (s.collapsedSpanIds.size > 0) {
                store.expandAllDeepSpans();
              } else {
                store.collapseAllDeepSpans();
              }
            }}
          >
            <span className="dropdown-item-icon">
              {s.collapsedSpanIds.size > 0 ? "▸" : "▾"}
            </span>
            <div className="dropdown-item-text">
              <span className="dropdown-item-title">
                {s.collapsedSpanIds.size > 0 ? "Expand Inner Calls" : "Collapse Inner Calls"}
              </span>
              <span className="dropdown-item-sub">
                {s.collapsedSpanIds.size > 0
                  ? `${s.collapsedSpanIds.size} parent calls collapsed`
                  : "Fold deep child calls under parents"}
              </span>
            </div>
            <span className={"dropdown-switch" + (s.collapsedSpanIds.size > 0 ? " on" : "")} />
          </button>

          {/* Show All Requests / Focus Armed */}
          <button
            type="button"
            className={"dropdown-item" + (s.selectedOnly ? " active" : "")}
            onClick={() => store.toggleSelectedOnly()}
          >
            <span className="dropdown-item-icon">≡</span>
            <div className="dropdown-item-text">
              <span className="dropdown-item-title">
                {s.selectedOnly ? "Focus Armed Requests" : "Show All Requests"}
              </span>
              <span className="dropdown-item-sub">
                {s.selectedOnly
                  ? "Only requests where armed functions ran"
                  : "Showing every request & background log"}
              </span>
            </div>
            <span className={"dropdown-switch" + (s.selectedOnly ? " on" : "")} />
          </button>
        </div>
      )}
    </div>
  );
}

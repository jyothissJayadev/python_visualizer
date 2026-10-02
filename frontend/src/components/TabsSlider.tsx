import { useLayoutEffect, useRef, useState } from "react";
import type { AppTab } from "../lib/router";
import { useInstance } from "../lib/instance";

interface Props {
  activeTab: AppTab;
  onSelectTab: (tab: AppTab) => void;
  routesCount?: number;
  databaseCount?: number;
  lineageCount?: number;
  totalEvents?: number;
}

export function TabsSlider({
  activeTab,
  onSelectTab,
  routesCount = 0,
  databaseCount = 16,
  lineageCount = 0,
  totalEvents = 0,
}: Props) {
  const { features } = useInstance();
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalBtnRef = useRef<HTMLButtonElement>(null);
  const routesBtnRef = useRef<HTMLButtonElement>(null);
  const databaseBtnRef = useRef<HTMLButtonElement>(null);
  const lineageBtnRef = useRef<HTMLButtonElement>(null);
  const mapBtnRef = useRef<HTMLButtonElement>(null);

  const [indicatorStyle, setIndicatorStyle] = useState<{
    left: number;
    width: number;
    ready: boolean;
  }>({
    left: 3,
    width: 0,
    ready: false,
  });

  // Measure the active button's exact offset and width
  useLayoutEffect(() => {
    const updateIndicator = () => {
      let activeBtn: HTMLButtonElement | null = null;
      if (activeTab === "terminal") {
        activeBtn = terminalBtnRef.current;
      } else if (activeTab === "routes") {
        activeBtn = routesBtnRef.current;
      } else if (activeTab === "database") {
        activeBtn = databaseBtnRef.current;
      } else if (activeTab === "lineage") {
        activeBtn = lineageBtnRef.current;
      } else if (activeTab === "map") {
        activeBtn = mapBtnRef.current;
      }

      const container = containerRef.current;

      if (activeBtn && container) {
        const btnRect = activeBtn.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const left = btnRect.left - containerRect.left;
        const width = btnRect.width;

        setIndicatorStyle({
          left,
          width,
          ready: true,
        });
      }
    };

    updateIndicator();

    // Listen for resize changes
    const container = containerRef.current;
    if (typeof ResizeObserver !== "undefined" && container) {
      const observer = new ResizeObserver(() => updateIndicator());
      observer.observe(container);
      if (terminalBtnRef.current) observer.observe(terminalBtnRef.current);
      if (routesBtnRef.current) observer.observe(routesBtnRef.current);
      if (databaseBtnRef.current) observer.observe(databaseBtnRef.current);
      if (lineageBtnRef.current) observer.observe(lineageBtnRef.current);
      if (mapBtnRef.current) observer.observe(mapBtnRef.current);
      return () => observer.disconnect();
    }
  }, [activeTab, routesCount, databaseCount, lineageCount, totalEvents]);

  return (
    <div
      className="tabs-slider-container"
      role="tablist"
      aria-label="Main Views"
      ref={containerRef}
    >
      {/* Dynamic Sliding Background Indicator */}
      <div
        className={`tabs-slider-indicator tab-theme-${activeTab}`}
        style={{
          transform: `translate3d(${indicatorStyle.left}px, 0, 0)`,
          width: indicatorStyle.width > 0 ? `${indicatorStyle.width}px` : "auto",
          opacity: indicatorStyle.ready ? 1 : 0,
        }}
      />

      <button
        ref={terminalBtnRef}
        type="button"
        role="tab"
        aria-selected={activeTab === "terminal"}
        className={`tabs-slider-btn ${activeTab === "terminal" ? "active active-terminal" : ""}`}
        onClick={() => onSelectTab("terminal")}
        title="Live telemetry trace stream & I/O inspector"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="tab-icon"
        >
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
        <span className="tab-label">Terminal</span>
        {totalEvents > 0 && (
          <span className="tab-badge terminal-events-badge">
            {totalEvents > 999 ? `${(totalEvents / 1000).toFixed(1)}k` : totalEvents}
          </span>
        )}
      </button>

      {features.includes("routes") && (
      <button
        ref={routesBtnRef}
        type="button"
        role="tab"
        aria-selected={activeTab === "routes"}
        className={`tabs-slider-btn ${activeTab === "routes" ? "active active-routes" : ""}`}
        onClick={() => onSelectTab("routes")}
        title="Visual hierarchical function flow & endpoint routing diagrams"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="tab-icon"
        >
          <circle cx="6" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <line x1="6" y1="9" x2="6" y2="15" />
          <path d="M9 18h6a3 3 0 0 0 3-3V9a3 3 0 0 0-3-3H9" />
          <circle cx="18" cy="9" r="3" />
        </svg>
        <span className="tab-label">Endpoints</span>
        <span className="tab-badge routes-count-badge">
          {routesCount > 0 ? routesCount : "Flows"}
        </span>
      </button>
      )}

      {features.includes("database") && (
      <button
        ref={databaseBtnRef}
        type="button"
        role="tab"
        aria-selected={activeTab === "database"}
        className={`tabs-slider-btn ${activeTab === "database" ? "active active-database" : ""}`}
        onClick={() => onSelectTab("database")}
        title="Database Schema, MongoDB & Neo4j ER, Lineage & Call Chains"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="tab-icon"
        >
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
        </svg>
        <span className="tab-label">Database</span>
        <span className="tab-badge database-count-badge">
          {databaseCount > 0 ? databaseCount : "Schema"}
        </span>
      </button>
      )}

      {features.includes("lineage") && (
      <button
        ref={lineageBtnRef}
        type="button"
        role="tab"
        aria-selected={activeTab === "lineage"}
        className={`tabs-slider-btn ${activeTab === "lineage" ? "active active-lineage" : ""}`}
        onClick={() => onSelectTab("lineage")}
        title="End-to-End Lineage: Brain Endpoint → Backend Service/Route → Client API → UI Component"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="tab-icon"
        >
          <rect x="2" y="3" width="5" height="5" rx="1" />
          <rect x="17" y="3" width="5" height="5" rx="1" />
          <rect x="2" y="16" width="5" height="5" rx="1" />
          <rect x="17" y="16" width="5" height="5" rx="1" />
          <path d="M7 5.5h10M4.5 8v8M19.5 8v8M7 18.5h10" />
        </svg>
        <span className="tab-label">Lineage</span>
        <span className="tab-badge lineage-count-badge">
          {lineageCount > 0 ? lineageCount : "E2E"}
        </span>
      </button>
      )}
      {features.includes("map") && (
      <button
        ref={mapBtnRef}
        type="button"
        role="tab"
        aria-selected={activeTab === "map"}
        className={`tabs-slider-btn ${activeTab === "map" ? "active active-map" : ""}`}
        onClick={() => onSelectTab("map")}
        title="Project map: entry points, main functions and their algorithms, zoomable"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="tab-icon">
          <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
          <line x1="8" y1="2" x2="8" y2="18" />
          <line x1="16" y1="6" x2="16" y2="22" />
        </svg>
        <span className="tab-label">Map</span>
      </button>
      )}
    </div>
  );
}

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type {
  DatabaseRelationship,
  DatabaseTable,
  RelationType,
} from "../../lib/databaseEngine";
import { DatabaseTableCard } from "./DatabaseTableCard";

interface Props {
  tables: DatabaseTable[];
  relationships: DatabaseRelationship[];
  selectedTableId: string | null;
  relationFilter: "all" | RelationType;
  onSelectTable: (id: string) => void;
  onFilterRelationChange: (filter: "all" | RelationType) => void;
}

const CARD_WIDTH = 260;
const CARD_HEIGHT = 210;

interface Point {
  x: number;
  y: number;
}

interface BezierPath {
  id: string;
  rel: DatabaseRelationship;
  d: string;
  labelX: number;
  labelY: number;
  type: RelationType;
  isSelf: boolean;
}

export function DatabaseDiagramCanvas({
  tables,
  relationships,
  selectedTableId,
  relationFilter,
  onSelectTable,
  onFilterRelationChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Pan & Zoom transform
  const [pan, setPan] = useState<Point>({ x: 40, y: 30 });
  const [zoom, setZoom] = useState<number>(0.80);
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const panStartRef = useRef<Point>({ x: 0, y: 0 });

  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  useEffect(() => {
    zoomRef.current = zoom;
    panRef.current = pan;
  }, [zoom, pan]);

  // Movable custom card positions
  const [customPositions, setCustomPositions] = useState<Record<string, Point>>({});
  const draggingCardRef = useRef<{
    id: string;
    startMouseX: number;
    startMouseY: number;
    startX: number;
    startY: number;
    hasMoved: boolean;
  } | null>(null);

  // Quick lookup of tables by ID
  const tableMap = useMemo(() => {
    const map = new Map<string, DatabaseTable>();
    for (const t of tables) {
      map.set(t.id, t);
    }
    return map;
  }, [tables]);

  const getTablePos = useCallback(
    (t: DatabaseTable): Point => {
      return customPositions[t.id] ?? { x: t.x ?? 0, y: t.y ?? 0 };
    },
    [customPositions]
  );

  // Fit to screen calculation (Explicit action or initial mount ONLY)
  const handleFitToScreen = useCallback(() => {
    if (!containerRef.current || tables.length === 0) return;
    const rect = containerRef.current.getBoundingClientRect();

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const t of tables) {
      const pos = getTablePos(t);
      if (pos.x < minX) minX = pos.x;
      if (pos.y < minY) minY = pos.y;
      if (pos.x + CARD_WIDTH > maxX) maxX = pos.x + CARD_WIDTH;
      if (pos.y + CARD_HEIGHT > maxY) maxY = pos.y + CARD_HEIGHT;
    }

    const contentWidth = maxX - minX + 80;
    const contentHeight = maxY - minY + 80;

    const scaleX = (rect.width - 40) / contentWidth;
    const scaleY = (rect.height - 40) / contentHeight;
    const targetZoom = Math.min(1.0, Math.max(0.68, Math.min(scaleX, scaleY)));

    const targetPanX =
      contentWidth * targetZoom > rect.width
        ? 35 - minX * targetZoom
        : Math.max(35, (rect.width - (maxX - minX) * targetZoom) / 2 - minX * targetZoom);

    const targetPanY = Math.max(
      24,
      contentHeight * targetZoom > rect.height
        ? 24 - minY * targetZoom
        : (rect.height - (maxY - minY) * targetZoom) / 2 - minY * targetZoom
    );

    setZoom(targetZoom);
    setPan({ x: targetPanX, y: targetPanY });
  }, [tables, getTablePos]);

  // Initial fit ONLY ONCE on mount — NEVER automatically on hover or selection!
  const hasInitialFitRef = useRef(false);
  useEffect(() => {
    if (!hasInitialFitRef.current && tables.length > 0) {
      hasInitialFitRef.current = true;
      handleFitToScreen();
    }
  }, [tables.length, handleFitToScreen]);

  // Card mouse down for dragging
  const handleCardMouseDown = (tableId: string, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".db-key-pill.fk") || (e.target as HTMLElement).closest("button")) {
      return;
    }
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    const table = tableMap.get(tableId);
    if (!table) return;
    const pos = getTablePos(table);
    draggingCardRef.current = {
      id: tableId,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startX: pos.x,
      startY: pos.y,
      hasMoved: false,
    };
  };

  // Mouse pan handler on canvas backdrop
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".db-table-card")) return;
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    setIsPanning(true);
    panStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (draggingCardRef.current) return;
    if (!isPanning) return;
    setPan({
      x: e.clientX - panStartRef.current.x,
      y: e.clientY - panStartRef.current.y,
    });
  };

  const handleMouseUp = useCallback(() => {
    const dragging = draggingCardRef.current;
    if (dragging) {
      if (!dragging.hasMoved) {
        onSelectTable(dragging.id);
      }
      draggingCardRef.current = null;
    }
    setIsPanning(false);
  }, [onSelectTable]);

  // Window-level mouse move and mouse up listeners for smooth, glitch-free dragging & panning
  useEffect(() => {
    const onWindowMouseMove = (e: MouseEvent) => {
      const dragging = draggingCardRef.current;
      if (dragging) {
        const dx = (e.clientX - dragging.startMouseX) / zoomRef.current;
        const dy = (e.clientY - dragging.startMouseY) / zoomRef.current;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
          dragging.hasMoved = true;
          const newX = Math.round(dragging.startX + dx);
          const newY = Math.round(dragging.startY + dy);
          // Capture cardId synchronously before queuing state update to prevent reading null on fast mouseup!
          const cardId = dragging.id;
          setCustomPositions((prev) => ({
            ...prev,
            [cardId]: { x: newX, y: newY },
          }));
        }
      }
    };

    const onWindowMouseUp = () => {
      handleMouseUp();
    };

    window.addEventListener("mousemove", onWindowMouseMove);
    window.addEventListener("mouseup", onWindowMouseUp);
    window.addEventListener("blur", onWindowMouseUp);

    return () => {
      window.removeEventListener("mousemove", onWindowMouseMove);
      window.removeEventListener("mouseup", onWindowMouseUp);
      window.removeEventListener("blur", onWindowMouseUp);
    };
  }, [handleMouseUp]);

  // Wheel zoom handler using an active non-passive listener so e.preventDefault() is permitted without browser warnings
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const curZoom = zoomRef.current;
      const curPan = panRef.current;
      const delta = -e.deltaY * 0.0012;
      const nextZoom = Math.min(1.8, Math.max(0.40, curZoom + delta));
      const scaleRatio = nextZoom / curZoom;

      const newPanX = mouseX - (mouseX - curPan.x) * scaleRatio;
      const newPanY = mouseY - (mouseY - curPan.y) * scaleRatio;

      setZoom(nextZoom);
      setPan({ x: newPanX, y: newPanY });
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  // Compute Bezier Connection Paths dynamically between enabled tables
  const paths: BezierPath[] = useMemo(() => {
    const list: BezierPath[] = [];

    for (const rel of relationships) {
      const src = tableMap.get(rel.fromTableId);
      const tgt = tableMap.get(rel.toTableId);
      if (!src || !tgt) continue;

      const isSelf = rel.fromTableId === rel.toTableId;
      const spos = getTablePos(src);
      const tpos = getTablePos(tgt);
      const sx = spos.x;
      const sy = spos.y;
      const tx = tpos.x;
      const ty = tpos.y;

      if (isSelf) {
        const startX = sx + CARD_WIDTH;
        const startY = sy + 45;
        const endX = sx + CARD_WIDTH;
        const endY = sy + 135;
        const loopDist = 70;

        const d = `M ${startX} ${startY} C ${startX + loopDist} ${startY - 30}, ${endX + loopDist} ${endY + 30}, ${endX} ${endY}`;
        list.push({
          id: rel.id,
          rel,
          d,
          labelX: startX + loopDist + 4,
          labelY: (startY + endY) / 2,
          type: rel.type,
          isSelf: true,
        });
        continue;
      }

      let startX: number;
      let startY: number;
      let endX: number;
      let endY: number;
      let cx1: number;
      let cy1: number;
      let cx2: number;
      let cy2: number;

      const dx = tx - sx;
      const dy = ty - sy;

      if (dx >= CARD_WIDTH * 0.75) {
        startX = sx + CARD_WIDTH;
        startY = sy + 75;
        endX = tx;
        endY = ty + 75;
        const curveOffset = Math.max(50, Math.abs(dx) * 0.45);
        cx1 = startX + curveOffset;
        cy1 = startY;
        cx2 = endX - curveOffset;
        cy2 = endY;
      } else if (dx <= -CARD_WIDTH * 0.75) {
        startX = sx;
        startY = sy + 75;
        endX = tx + CARD_WIDTH;
        endY = ty + 75;
        const curveOffset = Math.max(50, Math.abs(dx) * 0.45);
        cx1 = startX - curveOffset;
        cy1 = startY;
        cx2 = endX + curveOffset;
        cy2 = endY;
      } else if (dy >= 0) {
        startX = sx + CARD_WIDTH * 0.5;
        startY = sy + CARD_HEIGHT;
        endX = tx + CARD_WIDTH * 0.5;
        endY = ty;
        const curveOffset = Math.max(40, Math.abs(dy) * 0.4);
        cx1 = startX;
        cy1 = startY + curveOffset;
        cx2 = endX;
        cy2 = endY - curveOffset;
      } else {
        startX = sx + CARD_WIDTH * 0.5;
        startY = sy;
        endX = tx + CARD_WIDTH * 0.5;
        endY = ty + CARD_HEIGHT;
        const curveOffset = Math.max(40, Math.abs(dy) * 0.4);
        cx1 = startX;
        cy1 = startY - curveOffset;
        cx2 = endX;
        cy2 = endY + curveOffset;
      }

      const d = `M ${startX} ${startY} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${endX} ${endY}`;
      const labelX = 0.125 * startX + 0.375 * cx1 + 0.375 * cx2 + 0.125 * endX;
      const labelY = 0.125 * startY + 0.375 * cy1 + 0.375 * cy2 + 0.125 * endY;

      list.push({
        id: rel.id,
        rel,
        d,
        labelX,
        labelY,
        type: rel.type,
        isSelf: false,
      });
    }

    return list;
  }, [relationships, tableMap, getTablePos]);

  return (
    <div
      ref={containerRef}
      className={`db-canvas-container ${isPanning ? "panning" : ""}`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Background Engineering Dot Grid */}
      <div
        className="db-canvas-grid-bg"
        style={{
          backgroundPosition: `${pan.x}px ${pan.y}px`,
          backgroundSize: `${24 * zoom}px ${24 * zoom}px`,
        }}
      />

      {tables.length === 0 ? (
        <div className="db-canvas-empty-overlay">
          <div className="empty-box">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="9" x2="15" y2="15" />
              <line x1="15" y1="9" x2="9" y2="15" />
            </svg>
            <h3>No tables enabled in view mode</h3>
            <p>Use the checkboxes in the sidebar checklist to choose which tables to display.</p>
          </div>
        </div>
      ) : (
        /* Canvas Zoom & Pan Stage */
        <div
          className="db-canvas-stage"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "0 0",
          }}
        >
          {/* SVG Bezier Relationships Layer */}
          <svg className="db-canvas-svg-layer">
            <defs>
              <marker
                id="arrow-mongo"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--accent-cyan)" opacity="0.85" />
              </marker>
              <marker
                id="arrow-neo4j"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--accent-emerald)" opacity="0.85" />
              </marker>
              <marker
                id="arrow-cross"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--accent-amber)" />
              </marker>
            </defs>

            {/* Render Connection Curves — Always 100% visible, no hover hiding */}
            {paths.map((p) => {
              const marker =
                p.type === "cross_database"
                  ? "url(#arrow-cross)"
                  : p.type === "neo4j_edge"
                  ? "url(#arrow-neo4j)"
                  : "url(#arrow-mongo)";

              return (
                <g key={p.id} className={`db-relation-group rel-${p.type}`}>
                  {/* Stylized visible bezier path */}
                  <path
                    d={p.d}
                    className={`db-rel-path db-rel-${p.type}`}
                    markerEnd={marker}
                  />

                  {/* Midpoint badge label */}
                  <g transform={`translate(${p.labelX}, ${p.labelY})`}>
                    <rect
                      className={`db-rel-badge-bg ${p.type}`}
                      x={-(p.rel.label.length * 3.4 + 10)}
                      y="-10"
                      width={p.rel.label.length * 6.8 + 20}
                      height="20"
                      rx="10"
                    />
                    <text
                      className={`db-rel-badge-text ${p.type}`}
                      textAnchor="middle"
                      dy="3.5"
                    >
                      {p.rel.label}
                    </text>
                  </g>
                </g>
              );
            })}
          </svg>

          {/* HTML Cards Layer — Always 100% visible, no hover dimming/hiding */}
          <div className="db-cards-layer">
            {tables.map((table) => {
              const isSelected = selectedTableId === table.id;
              const pos = getTablePos(table);

              return (
                <DatabaseTableCard
                  key={table.id}
                  table={table}
                  position={pos}
                  selected={isSelected}
                  highlighted={false}
                  dimmed={false}
                  onSelect={onSelectTable}
                  onHover={() => {}}
                  onMouseDown={(e) => handleCardMouseDown(table.id, e)}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Floating Canvas Action Controls */}
      <div className="db-canvas-controls">
        <button
          className="db-control-btn"
          title="Zoom In"
          onClick={() => setZoom((z) => Math.min(1.8, z + 0.15))}
        >
          +
        </button>
        <span className="db-zoom-level-text">{Math.round(zoom * 100)}%</span>
        <button
          className="db-control-btn"
          title="Zoom Out"
          onClick={() => setZoom((z) => Math.max(0.40, z - 0.15))}
        >
          −
        </button>
        <button
          className="db-control-btn"
          title="Fit to Screen & Reset View"
          onClick={handleFitToScreen}
        >
          ⛶
        </button>
      </div>

      {/* Floating Relationship Filter Chips on Canvas */}
      <div className="db-canvas-relation-filters">
        <button
          className={`db-filter-chip ${relationFilter === "all" ? "active" : ""}`}
          onClick={() => onFilterRelationChange("all")}
        >
          All Links ({relationships.length})
        </button>
        <button
          className={`db-filter-chip cross ${relationFilter === "cross_database" ? "active" : ""}`}
          onClick={() => onFilterRelationChange("cross_database")}
          title="Show Mongo -> Neo4j Cross-Database Links only"
        >
          ⇄ Cross-DB
        </button>
        <button
          className={`db-filter-chip mongo ${relationFilter === "mongo_fk" ? "active" : ""}`}
          onClick={() => onFilterRelationChange("mongo_fk")}
        >
          Mongo FK
        </button>
        <button
          className={`db-filter-chip neo4j ${relationFilter === "neo4j_edge" ? "active" : ""}`}
          onClick={() => onFilterRelationChange("neo4j_edge")}
        >
          Neo4j Graph
        </button>
      </div>

      {/* Canvas Mini Instructions / Legend */}
      <div className="db-canvas-legend">
        <span className="legend-item"><i className="dot mongo" /> MongoDB</span>
        <span className="legend-item"><i className="dot neo4j" /> Neo4j</span>
        <span className="legend-item"><i className="line cross" /> Cross-DB Link</span>
        <span className="legend-hint">Showing {tables.length} tables · Drag to arrange</span>
      </div>
    </div>
  );
}

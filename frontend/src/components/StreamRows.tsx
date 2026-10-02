import { store } from "../lib/store";
import type { Snapshot, StreamRow } from "../lib/store";
import type { SpanData } from "../types";
import {
  decodeHtmlEntities,
  formatArgsPreview,
  formatDuration,
  formatTimestamp,
  getDurationBadgeClass,
  getFunctionTrackInfo,
} from "../lib/format";
import { TreeGuide } from "./TreeGuide";

function shortName(span: SpanData): string {
  const d = span.startEvent?.data;
  if (d?.qualname) return d.qualname;
  const label = d?.name || span.errorEvent?.data?.name || span.llmEvent?.data?.name;
  return label ? label.split(":").pop()! : "anonymous";
}

function highlightMatch(text: string, query: string) {
  if (!query.trim()) return text;
  const q = query.trim().toLowerCase();
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="fn-search-match">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

interface RowProps {
  row: StreamRow;
  snap: Snapshot;
}

export function StreamRowSwitch({ row, snap }: RowProps) {
  const currentHitSpanId =
    snap.traceFnSearchHits.length > 0
      ? snap.traceFnSearchHits[snap.traceFnSearchIndex]
      : null;
  const hasFnSearch = Boolean(snap.traceFnSearch.trim());

  if (row.rowKind === "log") {
    const level = (row.event.data?.level || "info").toLowerCase();
    return (
      <div className="stream-row row-log">
        <span style={{ color: "var(--text-dim)", marginRight: 6 }}>
          {formatTimestamp(row.event.ts)}
        </span>
        <span className={`log-level lvl-${level}`}>{level.toUpperCase()}</span>
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {row.event.data?.line || ""}
        </span>
      </div>
    );
  }

  if (row.rowKind === "loop") {
    const g = row.group;
    const n = g.memberSpanIds.length;
    let total = 0;
    let errs = 0;
    let max = 0;
    let firstSpan: SpanData | undefined;
    g.memberSpanIds.forEach((sid) => {
      const sp = snap.spans.get(sid);
      if (!sp) return;
      if (!firstSpan) firstSpan = sp;
      const d =
        sp.endEvent?.data?.duration_ms ?? sp.errorEvent?.data?.duration_ms ?? 0;
      total += d;
      if (d > max) max = d;
      if (sp.errorEvent) errs++;
    });
    const avg = n ? Math.round(total / n) : 0;
    const name = firstSpan ? shortName(firstSpan) : "loop";
    const track = getFunctionTrackInfo(firstSpan, snap);

    const isLoopHit = hasFnSearch && g.memberSpanIds.some((id) => snap.traceFnSearchHits.includes(id));
    const isLoopCurrent = hasFnSearch && Boolean(currentHitSpanId && g.memberSpanIds.includes(currentHitSpanId));

    return (
      <div
        id={`trace-span-${row.spanId}`}
        className={
          "stream-row loop-group-row" +
          (g.expanded ? " expanded" : "") +
          (track.isMain ? " row-main-fn" : "") +
          (isLoopCurrent ? " search-hit-current" : isLoopHit ? " search-hit" : "")
        }
        title={
          g.expanded
            ? "Collapse this run"
            : `Expand all ${n} iterations of ${name}()`
        }
        onClick={() => store.loopToggleExpand(g.key)}
      >
        <TreeGuide depth={row.depth} />
        <span className="loop-caret">{g.expanded ? "▾" : "▸"}</span>
        <div className="row-content" style={{ flex: "0 1 auto" }}>
          {track.isMain && (
            <span
              className={track.isDeep ? "badge badge-target-deep" : "badge badge-target"}
              title="Tracked Main Function Loop"
            >
              {track.isDeep ? "⚡ MAIN LOOP" : "🎯 MAIN LOOP"}
            </span>
          )}
          {isLoopHit && !g.expanded && (
            <span className="badge badge-search-hit" title="Loop contains matching function calls">
              🔍 MATCH
            </span>
          )}
          <span className="fn-name-label">
            <span className="loop-loop-icon">↻</span>
            <span>{highlightMatch(name, snap.traceFnSearch)}()</span>
          </span>
          <span className="loop-count">×{n}</span>
        </div>
        <span className="loop-stats">
          Σ{formatDuration(total)} · avg {formatDuration(avg)} · max{" "}
          {formatDuration(max)}
          {errs > 0 && (
            <>
              {" "}
              · <span className="loop-errs">⚠{errs}</span>
            </>
          )}
        </span>
      </div>
    );
  }

  const span = snap.spans.get(row.spanId);
  if (!span) return null;
  const selected = snap.selectedSpanId === row.spanId;
  const track = getFunctionTrackInfo(span, snap);

  const isHit = hasFnSearch && snap.traceFnSearchHits.includes(row.spanId);
  const isCurrent = hasFnSearch && currentHitSpanId === row.spanId;

  let cls = "stream-row" + (selected ? " selected" : "");
  if (isCurrent) {
    cls += " search-hit-current";
  } else if (isHit) {
    cls += " search-hit";
  }
  if (track.isMain) {
    cls += " row-main-fn";
    if (track.isDeep) cls += " row-main-deep";
  } else if (track.isRoot) {
    cls += " row-root-fn";
  }

  if (row.rowKind === "error") {
    const d = span.errorEvent?.data || {};
    const errFn = d.name ? d.name.split(":").pop()! : "function";
    return (
      <div id={`trace-span-${row.spanId}`} className={cls + " row-error"} onClick={() => store.selectSpan(row.spanId)}>
        <TreeGuide depth={row.depth} />
        <div className="row-content">
          {track.isMain && (
            <span className="badge badge-target" title="Tracked Main Function (Failed)">
              🎯 MAIN
            </span>
          )}
          <span className="fn-name-label">
            ⚠️ {highlightMatch(errFn, snap.traceFnSearch)}
          </span>
          <span className="badge badge-slow">{d.exc_type || "Error"}</span>
          <span className="fn-args-preview" style={{ color: "#fca5a5" }}>
            {d.message || ""}
          </span>
        </div>
        <div className="row-meta-right">
          <span className="badge badge-slow">
            {formatDuration(d.duration_ms || 0)}
          </span>
        </div>
      </div>
    );
  }

  if (row.rowKind === "llm") {
    const d = span.llmEvent?.data || {};
    const dur = d.duration_ms || 0;
    const tok = d.tokens;
    const llmLabel = d.label || "generation";
    return (
      <div id={`trace-span-${row.spanId}`} className={cls + " row-llm"} onClick={() => store.selectSpan(row.spanId)}>
        <TreeGuide depth={row.depth} />
        <div className="row-content">
          <span className="fn-name-label">✨ {highlightMatch(llmLabel, snap.traceFnSearch)}</span>
          <span className="badge badge-llm">{d.model || "llm"}</span>
          {tok && (
            <span className="badge badge-dim" style={{ fontSize: 10 }}>
              {tok.in || 0} in / {tok.out || 0} out
            </span>
          )}
        </div>
        <div className="row-meta-right">
          <span className={"badge " + getDurationBadgeClass(dur)}>
            {formatDuration(dur)}
          </span>
        </div>
      </div>
    );
  }

  // fn.start row
  const sd = span.startEvent?.data || {};
  const ed = span.endEvent?.data;
  const argsSummary = formatArgsPreview(sd.args);
  let resultPreview = "";
  if (ed && ed.result !== undefined) {
    const raw = decodeHtmlEntities(JSON.stringify(ed.result));
    if (raw && raw !== "{}")
      resultPreview = `→ ${raw.slice(0, 45)}${raw.length > 45 ? "…" : ""}`;
  }

  const childCount = snap.spanChildCounts.get(span.span_id) || 0;
  const hasChildren = childCount > 0;
  const isCollapsed = snap.collapsedSpanIds.has(span.span_id);

  const fnShort = shortName(span);
  const fullName = sd.name || span.errorEvent?.data?.name || "";
  const needle = snap.traceFnSearch.toLowerCase().trim();
  const shortMatches = needle ? fnShort.toLowerCase().includes(needle) : false;
  const pkgMatches = needle && !shortMatches && fullName.toLowerCase().includes(needle);

  return (
    <div id={`trace-span-${row.spanId}`} className={cls} onClick={() => store.selectSpan(row.spanId)}>
      <TreeGuide depth={row.depth} />
      <div className="row-content">
        {hasChildren && (
          <button
            type="button"
            className={"span-collapse-btn" + (isCollapsed ? " is-collapsed" : " is-expanded")}
            title={
              isCollapsed
                ? `Click to expand ${childCount} inner nested calls`
                : `Click to collapse ${childCount} inner nested calls`
            }
            onClick={(e) => {
              e.stopPropagation();
              store.toggleSpanCollapse(span.span_id);
            }}
          >
            <span className="span-collapse-icon">{isCollapsed ? "▸" : "▾"}</span>
          </button>
        )}
        {track.isMain ? (
          <span
            className={track.isDeep ? "badge badge-target-deep" : "badge badge-target"}
            title={
              track.isDeep
                ? "🎯 Instrumented Main Function (Deep Tracing Mode - Captures all sub-calls)"
                : "🎯 Instrumented Main Function (Top-Level Mode)"
            }
          >
            {track.isDeep ? "⚡ MAIN TARGET" : "🎯 MAIN"}
          </span>
        ) : track.isRoot ? (
          <span className="badge badge-entry-root" title="Trace Entry Point (Root Function)">
            ↳ ENTRY
          </span>
        ) : null}
        <span className="fn-name-label">{highlightMatch(fnShort, snap.traceFnSearch)}</span>
        {pkgMatches && (
          <span className="badge badge-pkg-match" title={fullName}>
            in {fullName.split(":")[0]}
          </span>
        )}
        {isCollapsed && hasChildren && (
          <span
            className="badge badge-dim inner-collapsed-pill"
            title={`Click to expand ${childCount} inner deep calls`}
            onClick={(e) => {
              e.stopPropagation();
              store.toggleSpanCollapse(span.span_id);
            }}
          >
            +{childCount} inner {childCount === 1 ? "call" : "calls"}
          </span>
        )}
        <span className="fn-args-preview" title={argsSummary}>
          {argsSummary}
        </span>
        {resultPreview && (
          <span className="fn-result-preview">{resultPreview}</span>
        )}
      </div>
      <div className="row-meta-right">
        {ed ? (
          <span className={"badge " + getDurationBadgeClass(ed.duration_ms || 0)}>
            {formatDuration(ed.duration_ms || 0)}
          </span>
        ) : (
          <span
            className="badge badge-dim"
            style={{ fontSize: 10, opacity: 0.6 }}
          >
            running
          </span>
        )}
      </div>
    </div>
  );
}

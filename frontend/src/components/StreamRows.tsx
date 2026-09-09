import { store } from "../lib/store";
import type { Snapshot, StreamRow } from "../lib/store";
import type { SpanData } from "../types";
import {
  decodeHtmlEntities,
  formatArgsPreview,
  formatDuration,
  formatTimestamp,
  getDurationBadgeClass,
} from "../lib/format";
import { TreeGuide } from "./TreeGuide";

function shortName(span: SpanData): string {
  const d = span.startEvent?.data;
  if (d?.qualname) return d.qualname;
  const label = d?.name || span.errorEvent?.data?.name || span.llmEvent?.data?.name;
  return label ? label.split(":").pop()! : "anonymous";
}

interface RowProps {
  row: StreamRow;
  snap: Snapshot;
  currentLoopMembers: Set<string>;
}

export function StreamRowSwitch({ row, snap, currentLoopMembers }: RowProps) {
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
    let cur: SpanData | undefined;
    g.memberSpanIds.forEach((sid, idx) => {
      const sp = snap.spans.get(sid);
      if (!sp) return;
      const d =
        sp.endEvent?.data?.duration_ms ?? sp.errorEvent?.data?.duration_ms ?? 0;
      total += d;
      if (d > max) max = d;
      if (sp.errorEvent) errs++;
      if (idx === g.currentIndex) cur = sp;
    });
    const avg = n ? Math.round(total / n) : 0;
    const name = cur ? shortName(cur) : "loop";
    return (
      <div
        className={
          "stream-row loop-group-row" +
          (snap.selectedSpanId === row.spanId ? " selected" : "")
        }
      >
        <TreeGuide depth={row.depth} />
        <span
          className="loop-caret"
          title="Expand / collapse all iterations"
          onClick={() => store.loopToggleExpand(g.key)}
        >
          {g.expanded ? "▾" : "▸"}
        </span>
        <div className="row-content" style={{ flex: "0 1 auto" }}>
          <span className="fn-name-label">
            <span className="loop-loop-icon">↻</span>
            <span>{name}()</span>
          </span>
        </div>
        <span className="loop-position">
          {g.currentIndex + 1} / {n}
        </span>
        <button
          className="loop-step-btn"
          title="Previous iteration"
          onClick={() => store.loopStep(g.key, -1)}
        >
          ‹ Prev
        </button>
        <button
          className="loop-step-btn"
          title="Next iteration"
          onClick={() => store.loopStep(g.key, 1)}
        >
          Next ›
        </button>
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
        <button
          className="loop-expand-all"
          title="Show every iteration inline"
          onClick={() => store.loopToggleExpand(g.key)}
        >
          ⤢
        </button>
      </div>
    );
  }

  const span = snap.spans.get(row.spanId);
  if (!span) return null;
  const selected = snap.selectedSpanId === row.spanId;
  const isCurrentLoopMember = currentLoopMembers.has(row.spanId);
  const cls =
    "stream-row" +
    (selected ? " selected" : "") +
    (isCurrentLoopMember ? " loop-iteration-current" : "");

  if (row.rowKind === "error") {
    const d = span.errorEvent?.data || {};
    return (
      <div className={cls + " row-error"} onClick={() => store.selectSpan(row.spanId)}>
        <TreeGuide depth={row.depth} />
        <div className="row-content">
          <span className="fn-name-label">
            ⚠️ {d.name ? d.name.split(":").pop() : "function"}
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
    return (
      <div className={cls + " row-llm"} onClick={() => store.selectSpan(row.spanId)}>
        <TreeGuide depth={row.depth} />
        <div className="row-content">
          <span className="fn-name-label">✨ {d.label || "generation"}</span>
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

  return (
    <div className={cls} onClick={() => store.selectSpan(row.spanId)}>
      <TreeGuide depth={row.depth} />
      <div className="row-content">
        <span className="fn-name-label">{shortName(span)}</span>
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

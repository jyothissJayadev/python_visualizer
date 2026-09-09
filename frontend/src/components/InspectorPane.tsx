import { store } from "../lib/store";
import { useTerminal } from "../lib/useTerminal";
import type { Snapshot } from "../lib/store";
import type { SpanData } from "../types";
import { formatDuration, renderValueText } from "../lib/format";
import { JsonHighlight } from "./JsonHighlight";

function copy(text: string, msg: string) {
  if (!text) return;
  navigator.clipboard?.writeText(text).then(
    () => store.pushToast(msg),
    () => store.pushToast("Copy failed"),
  );
}

function spanDuration(span: SpanData): number {
  return (
    span.endEvent?.data?.duration_ms ??
    span.errorEvent?.data?.duration_ms ??
    span.llmEvent?.data?.duration_ms ??
    0
  );
}

function parentDuration(span: SpanData, snap: Snapshot): number {
  if (span.parent_span_id) {
    const parent = snap.spans.get(span.parent_span_id);
    if (parent) return spanDuration(parent);
  }
  const req = snap.requestMeta.get(span.request_id);
  return req?.endEvent?.data?.duration_ms || 0;
}

function shortName(span: SpanData): string {
  const d = span.startEvent?.data;
  if (d?.qualname) return d.qualname;
  if (d?.name) return d.name.split(":").pop()!;
  if (span.llmEvent?.data?.label) return `✨ ${span.llmEvent.data.label}`;
  if (span.errorEvent?.data?.name)
    return `⚠️ ${span.errorEvent.data.name.split(":").pop()}`;
  return span.span_id;
}

function Breadcrumbs({ span, snap }: { span: SpanData; snap: Snapshot }) {
  const chain: SpanData[] = [];
  let curr: SpanData | undefined = span;
  while (curr) {
    chain.unshift(curr);
    curr = curr.parent_span_id
      ? snap.spans.get(curr.parent_span_id)
      : undefined;
  }
  return (
    <div className="breadcrumbs-bar">
      <span
        className="breadcrumb-item"
        title={`Request ID: ${span.request_id} (click to filter)`}
        onClick={() => store.setFilterQuery(span.request_id)}
      >
        {span.request_id}
      </span>
      {chain.map((item, idx) => {
        const isCurrent = idx === chain.length - 1;
        return (
          <span key={item.span_id}>
            <span className="breadcrumb-sep">{">"}</span>
            <span
              className={"breadcrumb-item" + (isCurrent ? " current" : "")}
              onClick={isCurrent ? undefined : () => store.selectSpan(item.span_id)}
            >
              {shortName(item)}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function FunctionContent({ span }: { span: SpanData }) {
  const sd = span.startEvent?.data || {};
  const ed = span.endEvent?.data || {};
  const errd = span.errorEvent?.data || null;

  return (
    <>
      <div className="io-card">
        <div className="io-card-header">
          <span>INPUT (Arguments)</span>
          <button
            className="btn-sm"
            onClick={() =>
              copy(JSON.stringify(sd.args, null, 2), "Arguments copied")
            }
          >
            Copy JSON
          </button>
        </div>
        <div className="io-card-content">
          {sd.args_truncated && (
            <div className="truncation-banner">
              <span>⚠️ Arguments payload is truncated</span>
              <button
                className="btn-sm btn-primary"
                onClick={() => store.loadFullValue(span, "args")}
              >
                ⚡ Load Full Value
              </button>
            </div>
          )}
          <div className="value-box">{renderValueText(sd.args ?? {})}</div>
        </div>
      </div>

      {errd ? (
        <div className="io-card" style={{ borderColor: "rgba(248,113,113,0.4)" }}>
          <div
            className="io-card-header"
            style={{ background: "#201014", color: "var(--accent-rose)" }}
          >
            <span>EXCEPTION (Error Traceback)</span>
            <button
              className="btn-sm"
              onClick={() =>
                copy(errd.traceback || errd.message || "", "Traceback copied")
              }
            >
              Copy Traceback
            </button>
          </div>
          <div className="io-card-content">
            <div
              style={{
                fontWeight: 600,
                fontSize: 12,
                color: "var(--accent-rose)",
              }}
            >
              {errd.exc_type}: {errd.message}
            </div>
            <div className="traceback-box">
              {errd.traceback || errd.message || "No traceback available."}
            </div>
          </div>
        </div>
      ) : (
        <div className="io-card">
          <div className="io-card-header">
            <span>OUTPUT (Return Value)</span>
            <button
              className="btn-sm"
              onClick={() =>
                copy(JSON.stringify(ed.result, null, 2), "Return value copied")
              }
            >
              Copy JSON
            </button>
          </div>
          <div className="io-card-content">
            {ed.result_truncated && (
              <div className="truncation-banner">
                <span>⚠️ Return value payload is truncated</span>
                <button
                  className="btn-sm btn-primary"
                  onClick={() => store.loadFullValue(span, "result")}
                >
                  ⚡ Load Full Value
                </button>
              </div>
            )}
            <div className="value-box">
              {renderValueText(
                ed.result !== undefined
                  ? ed.result
                  : span.endEvent
                    ? null
                    : "Call in progress...",
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function LlmContent({ span, snap }: { span: SpanData; snap: Snapshot }) {
  const d = span.llmEvent?.data || {};
  const messages = d.messages || [];
  return (
    <>
      <div className="io-card">
        <div
          className="io-card-header"
          style={{ background: "#171124", color: "var(--accent-violet)" }}
        >
          <span>PROMPT MESSAGES TRANSCRIPT ({messages.length})</span>
          <button
            className="btn-sm"
            onClick={() =>
              copy(JSON.stringify(messages, null, 2), "Transcript copied")
            }
          >
            Copy All Messages
          </button>
        </div>
        <div className="io-card-content">
          <div className="llm-transcript-box">
            {messages.map((m, i) => (
              <div key={i} className={`chat-bubble role-${m.role || "user"}`}>
                <div className="chat-bubble-header">
                  <span>{(m.role || "USER").toUpperCase()}</span>
                </div>
                <div className="chat-bubble-content">{m.content || ""}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="io-card">
        <div className="io-card-header">
          <span>MODEL OUTPUT</span>
          <button
            className="btn-sm"
            onClick={() =>
              copy(
                snap.llmTab === "raw"
                  ? d.raw_text || ""
                  : JSON.stringify(d.parsed, null, 2),
                `${snap.llmTab === "raw" ? "Raw text" : "Parsed JSON"} copied`,
              )
            }
          >
            Copy Output
          </button>
        </div>
        <div className="io-card-content">
          <div className="tab-bar">
            <button
              className={"tab-btn" + (snap.llmTab === "parsed" ? " active" : "")}
              onClick={() => store.setLlmTab("parsed")}
            >
              Structured Result (Parsed)
            </button>
            <button
              className={"tab-btn" + (snap.llmTab === "raw" ? " active" : "")}
              onClick={() => store.setLlmTab("raw")}
            >
              Raw Model Completion
            </button>
          </div>
          {snap.llmTab === "parsed" ? (
            <div className="json-code-box">
              <JsonHighlight value={d.parsed ?? {}} />
            </div>
          ) : (
            <div
              className="json-code-box"
              style={{ whiteSpace: "pre-wrap", color: "#f1f5f9" }}
            >
              {d.raw_text || ""}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export function InspectorPane() {
  const s = useTerminal();
  const span = s.selectedSpanId ? s.spans.get(s.selectedSpanId) : undefined;
  const hidden = !span;

  const duration = span ? spanDuration(span) : 0;
  const parentDur = span ? parentDuration(span, s) || duration || 1 : 1;
  const pct = Math.min(Math.round((duration / parentDur) * 100), 100);

  const isLlm = span?.kind === "llm.call" || (!!span?.llmEvent && !span.startEvent);
  const isError = !!span?.errorEvent;

  const sd = span?.startEvent?.data || {};
  const qualname =
    sd.qualname || (sd.name ? sd.name.split(":").pop()! : "function");
  const moduleName = sd.module || (sd.name ? sd.name.split(":")[0] : "app");

  let doc = "No docstring recorded.";
  if (span) {
    for (const g of s.catalog.groups) {
      const found = g.functions.find(
        (f) => f.id === sd.name || f.name === qualname,
      );
      if (found && found.doc) doc = found.doc;
    }
  }

  const llm = span?.llmEvent?.data || {};
  const tok = llm.tokens || { in: 0, out: 0 };

  return (
    <aside className={"inspector-pane" + (hidden ? " hidden" : "")}>
      {span && (
        <>
          <div className="inspector-header">
            <div className="inspector-top-bar">
              <div className="inspector-title-wrap">
                <span
                  className={
                    "badge inspector-kind-badge " +
                    (isLlm ? "badge-llm" : isError ? "badge-slow" : "badge-cyan")
                  }
                >
                  {isLlm
                    ? "LLM PIPELINE CALL"
                    : isError
                      ? "FUNCTION ERROR"
                      : "FUNCTION CALL"}
                </span>
                <span
                  className="badge badge-dim"
                  style={{ cursor: "pointer" }}
                  title="Click to copy span_id"
                  onClick={() => copy(span.span_id, "Span ID copied")}
                >
                  {span.span_id}
                </span>
              </div>
              <button
                className="btn-icon"
                title="Close Inspector (Esc)"
                onClick={() => store.closeInspector()}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <Breadcrumbs span={span} snap={s} />
          </div>

          <div className="inspector-body">
            <div className="timing-card">
              <div className="timing-card-header">
                <span>Execution Duration</span>
                <span
                  style={{
                    fontWeight: 600,
                    fontFamily: "var(--font-mono)",
                    color: "#fff",
                  }}
                >
                  {formatDuration(duration)}
                </span>
              </div>
              <div className="timing-meter">
                <div
                  className={"timing-bar-fill" + (isLlm ? " llm" : "")}
                  style={{ width: `${Math.max(pct, 4)}%` }}
                />
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 10,
                  color: "var(--text-muted)",
                }}
              >
                <span>
                  Span duration ({formatDuration(duration)}) vs parent (
                  {formatDuration(parentDur)})
                </span>
                <span>{pct}% of parent</span>
              </div>
            </div>

            {isLlm ? (
              <div
                className="fn-meta-box"
                style={{ borderColor: "rgba(192,132,252,0.3)" }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span className="badge badge-llm">
                    {llm.model || "LLM Model"}
                  </span>
                  <span className="badge badge-dim">
                    {llm.label || "structuring"}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    color: "var(--text-secondary)",
                    marginTop: 4,
                  }}
                >
                  Tokens: <strong>{(tok.in || 0).toLocaleString()}</strong> in ·{" "}
                  <strong>{(tok.out || 0).toLocaleString()}</strong> out ·{" "}
                  <strong>
                    {((tok.in || 0) + (tok.out || 0)).toLocaleString()}
                  </strong>{" "}
                  total
                </div>
              </div>
            ) : (
              <div className="fn-meta-box">
                <div className="fn-qualname">{qualname}</div>
                <div className="fn-module-path">{moduleName}</div>
                <div className="fn-sig-code">
                  {qualname}
                  {sd.signature || "(...)"}
                </div>
                <div className="fn-docstring">{doc}</div>
              </div>
            )}

            <div
              style={{ display: "flex", flexDirection: "column", gap: 12 }}
            >
              {isLlm ? (
                <LlmContent span={span} snap={s} />
              ) : (
                <FunctionContent span={span} />
              )}
            </div>
          </div>
        </>
      )}
    </aside>
  );
}

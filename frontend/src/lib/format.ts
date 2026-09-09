/* Formatting helpers ported from terminal.html. React escapes text for us,
   so the old escapeHtml() is gone; everything else is carried over. */

export function formatTimestamp(ts?: number): string {
  if (!ts) return "";
  const date = new Date(ts * 1000);
  return (
    date.toTimeString().split(" ")[0] +
    "." +
    String(date.getMilliseconds()).padStart(3, "0")
  );
}

export function formatDuration(ms?: number | null): string {
  if (ms == null) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function getDurationBadgeClass(ms: number): string {
  if (ms < 500) return "badge-fast";
  if (ms < 2000) return "badge-med";
  return "badge-slow";
}

/* brain's chat layer HTML-escapes some text before it reaches the graph, so
   values can arrive already containing &#039; / &quot; / &amp; etc. Decode
   them back (bounded to 2 passes). A detached <textarea> never executes
   markup. */
export function decodeHtmlEntities(str: unknown): string {
  let out = String(str);
  for (let i = 0; i < 2; i++) {
    if (!/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/.test(out)) break;
    const ta = document.createElement("textarea");
    ta.innerHTML = out;
    if (ta.value === out) break;
    out = ta.value;
  }
  return out;
}

export function formatArgsPreview(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    const vStr = typeof v === "object" && v !== null ? "{…}" : JSON.stringify(v);
    parts.push(`${k}=${vStr}`);
  }
  return decodeHtmlEntities(parts.join(", "));
}

/* A return value / argument bag rendered as plain readable text: strings
   shown as-is, objects pretty-printed, HTML entities decoded. */
export function renderValueText(value: unknown): string {
  if (value === undefined) return "(no value)";
  if (value === null) return "null";
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return decodeHtmlEntities(text);
}

export function getDeterministicColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = [
    "#4ade80",
    "#3ce7ff",
    "#7dffa8",
    "#2fae67",
    "#c58bff",
    "#ffcf4d",
    "#35d0a0",
  ];
  return colors[Math.abs(hash) % colors.length];
}

/* JSON with span-wrapped tokens for the .json-* CSS classes. Returned as an
   array of {text, cls} runs so React can render it without dangerouslySet. */
export interface JsonToken {
  text: string;
  cls: string | null;
}

export function tokenizeJson(jsonObj: unknown): JsonToken[] {
  let jsonStr: string;
  try {
    jsonStr = JSON.stringify(jsonObj, null, 2);
  } catch {
    jsonStr = String(jsonObj);
  }
  if (jsonStr === undefined) return [{ text: "undefined", cls: "json-null" }];
  if (!jsonStr) return [{ text: "null", cls: "json-null" }];

  const tokens: JsonToken[] = [];
  const re =
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(jsonStr)) !== null) {
    if (m.index > last) tokens.push({ text: jsonStr.slice(last, m.index), cls: null });
    const match = m[0];
    let cls = "json-num";
    if (/^"/.test(match)) cls = /:$/.test(match) ? "json-key" : "json-str";
    else if (/true|false/.test(match)) cls = "json-bool";
    else if (/null/.test(match)) cls = "json-null";
    tokens.push({ text: match, cls });
    last = m.index + match.length;
  }
  if (last < jsonStr.length) tokens.push({ text: jsonStr.slice(last), cls: null });
  return tokens;
}

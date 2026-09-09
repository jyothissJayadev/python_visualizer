import type { Snapshot } from "./store";
import type { SpanData } from "../types";

export interface FunctionTrackInfo {
  isMain: boolean;
  isDeep: boolean;
  isRoot: boolean;
  matchedId: string | null;
}

export function getFunctionTrackInfo(
  span: SpanData | undefined,
  snap: Snapshot,
): FunctionTrackInfo {
  if (!span) {
    return { isMain: false, isDeep: false, isRoot: false, matchedId: null };
  }

  const d = span.startEvent?.data;
  const name = d?.name || span.errorEvent?.data?.name || span.llmEvent?.data?.name;
  const qualname = d?.qualname || (name ? name.split(":").pop() : "");
  const mod = d?.module;

  let isMain = false;
  let isDeep = false;
  let matchedId: string | null = null;

  // 1. Check exact match in appliedSelection or selectedFunctions
  if (name && (snap.appliedSelection.has(name) || snap.selectedFunctions.has(name))) {
    isMain = true;
    matchedId = name;
  } else if (mod && qualname) {
    const fullId = `${mod}:${qualname}`;
    if (snap.appliedSelection.has(fullId) || snap.selectedFunctions.has(fullId)) {
      isMain = true;
      matchedId = fullId;
    }
  }

  // 2. Check suffix matching against catalog selections
  if (!isMain && qualname) {
    for (const sel of snap.selectedFunctions) {
      if (sel === qualname || sel.endsWith(`:${qualname}`)) {
        isMain = true;
        matchedId = sel;
        break;
      }
    }
  }
  if (!isMain && qualname) {
    for (const sel of snap.appliedSelection) {
      if (sel === qualname || sel.endsWith(`:${qualname}`)) {
        isMain = true;
        matchedId = sel;
        break;
      }
    }
  }

  if (isMain && matchedId) {
    isDeep = snap.functionModes.get(matchedId) === "deep";
  }

  const isRoot = !span.parent_span_id;

  return { isMain, isDeep, isRoot, matchedId };
}

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

/* Unwraps outer quotes and unescapes literal \n, \t, \r, \", \' in strings. */
export function formatFormattedString(str: unknown): string {
  if (str === undefined || str === null) return "";
  let text = String(str);
  // If wrapped in Python repr quotes ('...' or "..."), unwrap them
  if (
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2) ||
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2)
  ) {
    text = text.slice(1, -1);
  }
  // Unescape literal escape sequences
  if (text.includes("\\n") || text.includes("\\t") || text.includes('\\"') || text.includes("\\'")) {
    text = text
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\r/g, "\r")
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'");
  }
  return decodeHtmlEntities(text);
}

/* A return value / argument bag rendered as plain readable text: strings
   shown as-is, objects pretty-printed, HTML entities decoded. */
export function renderValueText(value: unknown): string {
  if (value === undefined) return "(no value)";
  if (value === null) return "null";
  let text: string;
  if (typeof value === "string") {
    text = formatFormattedString(value);
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
  if (jsonObj === undefined) return [{ text: "undefined", cls: "json-null" }];
  if (jsonObj === null) return [{ text: "null", cls: "json-null" }];

  try {
    jsonStr = typeof jsonObj === "string" ? jsonObj : JSON.stringify(jsonObj, null, 2);
  } catch {
    jsonStr = String(jsonObj);
  }

  if (jsonStr === undefined) return [{ text: "undefined", cls: "json-null" }];
  if (!jsonStr) return [{ text: "null", cls: "json-null" }];

  const tokens: JsonToken[] = [];
  // Matches:
  // 1. "key": (string key with trailing colon)
  // 2. "string" (string value)
  // 3. true | false | True | False (booleans)
  // 4. null | None | undefined (nulls)
  // 5. numbers (including decimals, exponents, negatives)
  // 6. structural punctuation: { } [ ] , :
  const re =
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null|None|True|False)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|[{}[\\],:])/g;

  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(jsonStr)) !== null) {
    if (m.index > last) {
      tokens.push({ text: jsonStr.slice(last, m.index), cls: null });
    }
    const match = m[0];

    if (/^"/.test(match)) {
      if (/:$/.test(match)) {
        // String Key followed by colon
        const colonIdx = match.lastIndexOf(":");
        const keyPart = match.slice(0, colonIdx);
        const colonPart = match.slice(colonIdx);
        tokens.push({ text: decodeHtmlEntities(keyPart), cls: "json-key" });
        tokens.push({ text: colonPart, cls: "json-colon" });
      } else {
        // String Value
        tokens.push({ text: decodeHtmlEntities(match), cls: "json-str" });
      }
    } else if (/^(?:true|false|True|False)$/.test(match)) {
      tokens.push({ text: match, cls: "json-bool" });
    } else if (/^(?:null|None|undefined)$/.test(match)) {
      tokens.push({ text: match, cls: "json-null" });
    } else if (/^[{}[\\],:]$/.test(match)) {
      tokens.push({ text: match, cls: "json-punct" });
    } else {
      tokens.push({ text: match, cls: "json-num" });
    }

    last = m.index + match.length;
  }

  if (last < jsonStr.length) {
    tokens.push({ text: jsonStr.slice(last), cls: null });
  }

  return tokens;
}

/* Decide how a value should be shown: as a pretty JSON tree (objects, arrays,
   booleans, numbers, and JSON-looking strings) or as plain readable text. */
export function asJsonValue(value: unknown): { json: unknown } | { text: string } {
  if (value === undefined) return { text: "(no value)" };
  if (value === null) return { json: null };
  if (typeof value === "boolean" || typeof value === "number") {
    return { json: value };
  }

  let candidate: unknown = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    const looksJson =
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
      (trimmed.startsWith("(") && trimmed.endsWith(")")) ||
      ((trimmed.startsWith('"') || trimmed.startsWith("'")) &&
        (trimmed.includes("{") || trimmed.includes("[") || trimmed.includes(":") || trimmed.includes(",")));
    if (looksJson) {
      const parsed = tryParseLoose(trimmed);
      if (parsed !== undefined) {
        candidate = parsed;
      }
    }
  }

  if (candidate !== null && typeof candidate === "object") {
    return { json: candidate };
  }
  if (typeof candidate === "boolean" || typeof candidate === "number") {
    return { json: candidate };
  }
  return { text: renderValueText(value) };
}

/* Pretty JSON string for the "Copy JSON" buttons — unwraps a value that is
   itself a JSON/repr string so the clipboard gets real formatted JSON. */
export function toPrettyJson(value: unknown): string {
  const shaped = asJsonValue(value);
  if ("json" in shaped) {
    try {
      return JSON.stringify(shaped.json, null, 2);
    } catch {
      /* fall through */
    }
  }
  return typeof value === "string" ? value : renderValueText(value);
}

/* Parse strict JSON first; fall back to Python-ish reprs that brain sometimes
   emits for return values ({'k': 'v'}, None/True/False, tuples). Returns
   undefined when nothing parses, so the caller can keep the raw string. */
export function tryParseLoose(src: string): unknown {
  if (!src || typeof src !== "string") return undefined;
  const decoded = decodeHtmlEntities(src.trim());

  // 1. Direct JSON parse
  try {
    return JSON.parse(decoded);
  } catch {
    /* continue */
  }

  // 2. Python tuple to list conversion: (1, 2, 3) -> [1, 2, 3]
  let s = decoded;
  if (s.startsWith("(") && s.endsWith(")")) {
    s = "[" + s.slice(1, -1) + "]";
  }

  // 3. Convert Python dict / list repr to valid JSON
  try {
    const pyConverted = s
      .replace(/:\s*None\b/g, ": null")
      .replace(/\[\s*None\b/g, "[null")
      .replace(/,\s*None\b/g, ", null")
      .replace(/:\s*True\b/g, ": true")
      .replace(/\[\s*True\b/g, "[true")
      .replace(/,\s*True\b/g, ", true")
      .replace(/:\s*False\b/g, ": false")
      .replace(/\[\s*False\b/g, "[false")
      .replace(/,\s*False\b/g, ", false")
      // Convert single quoted keys: {'key': -> {"key": or , 'key': -> , "key":
      .replace(/(^|[{,\s])'([^'\\]*(?:\\.[^'\\]*)*)'\s*:/g, '$1"$2":')
      // Convert single quoted string values: : 'val' -> : "val"
      .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ': "$1"')
      // Convert single quoted array elements: ['val' -> ["val" or , 'val' -> , "val"
      .replace(/([[,\s])'([^'\\]*(?:\\.[^'\\]*)*)'(?=\s*[,\]])/g, '$1"$2"');

    return JSON.parse(pyConverted);
  } catch {
    /* fallback */
  }

  return undefined;
}

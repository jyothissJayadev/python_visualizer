import { asJsonValue, formatFormattedString, tokenizeJson } from "../lib/format";

/** Syntax-highlighted pretty JSON — ports formatJsonHighlight(). */
export function JsonHighlight({ value }: { value: unknown }) {
  const tokens = tokenizeJson(value);
  return (
    <>
      {tokens.map((t, i) =>
        t.cls ? (
          <span key={i} className={t.cls}>
            {t.text}
          </span>
        ) : (
          <span key={i}>{t.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Formats multi-line text, prompt trees, and documents into structured lines,
 * highlighting section headers, key-value lines, and paragraphs cleanly.
 */
export function StructuredTextView({ text }: { text: string }) {
  const unescaped = formatFormattedString(text);
  const lines = unescaped.split("\n");

  return (
    <div className="json-code-box string-doc-box">
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return <div key={i} className="doc-empty-line">&nbsp;</div>;
        }

        // Section header detection (e.g., CURRENT DATA TREE, # Heading, Section Name:)
        const isAllUpperHeader =
          trimmed.length > 2 &&
          trimmed === trimmed.toUpperCase() &&
          /^[A-Z0-9\s_-]+:?$/.test(trimmed);
        const isMarkdownHeader = /^#{1,4}\s+/.test(trimmed);
        const isColonHeader = /^[A-Za-z\s_-]{3,30}:$/.test(trimmed);

        if (isAllUpperHeader || isMarkdownHeader || isColonHeader) {
          return (
            <div key={i} className="doc-section-header">
              {line}
            </div>
          );
        }

        // Key: Value line detection (e.g. "Currently pending question (if any): none")
        const kvMatch = line.match(/^(\s*[A-Za-z0-9_.\s()-]+:\s*)(.+)$/);
        if (kvMatch && !trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
          const keyPart = kvMatch[1];
          const valPart = kvMatch[2];
          return (
            <div key={i} className="doc-kv-line">
              <span className="doc-kv-key">{keyPart}</span>
              <span className="doc-kv-val">{valPart}</span>
            </div>
          );
        }

        // Normal text line
        return (
          <div key={i} className="doc-text-line">
            {line}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Renders an argument bag / return value: objects, arrays and JSON-looking
 * strings become a pretty, syntax-highlighted JSON tree; multi-line strings / prompts
 * become structured readable documents; simple values stay clean readable text.
 */
export function ValueView({ value }: { value: unknown }) {
  const shaped = asJsonValue(value);

  if ("json" in shaped) {
    if (
      shaped.json !== null &&
      typeof shaped.json === "object" &&
      Object.keys(shaped.json as object).length === 0
    ) {
      const isArr = Array.isArray(shaped.json);
      return (
        <div className="json-code-box json-code-box-empty">
          <span className="json-punct">{isArr ? "[]" : "{}"}</span>
          <span className="value-box-empty-hint"> (empty {isArr ? "array" : "object"})</span>
        </div>
      );
    }
    return (
      <div className="json-code-box">
        <JsonHighlight value={shaped.json} />
      </div>
    );
  }

  // Handle multi-line strings / prompt trees / documents
  const rawText = shaped.text;
  if (typeof rawText === "string" && (rawText.includes("\n") || rawText.includes("\\n"))) {
    return <StructuredTextView text={rawText} />;
  }

  return (
    <div className="json-code-box string-doc-box">
      <div className="doc-text-line">{formatFormattedString(rawText)}</div>
    </div>
  );
}

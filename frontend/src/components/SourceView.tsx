export function SourceView({ source, startLine }: { source: string; startLine: number }) {
  const lines = source.replace(/\n$/, "").split("\n");
  return (
    <pre
      style={{
        background: "#0f172a",
        color: "#e2e8f0",
        padding: 12,
        borderRadius: 8,
        overflowX: "auto",
        fontSize: 13,
        lineHeight: 1.5,
        margin: 0,
      }}
    >
      {lines.map((line, i) => (
        <div key={i} style={{ display: "flex" }}>
          <span style={{ color: "#64748b", width: 40, textAlign: "right", marginRight: 12, userSelect: "none" }}>
            {startLine + i}
          </span>
          <span style={{ whiteSpace: "pre" }}>{line}</span>
        </div>
      ))}
    </pre>
  );
}

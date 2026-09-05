import type { ParameterInfo } from "../types";

export function ParameterList({ parameters }: { parameters: ParameterInfo[] }) {
  if (parameters.length === 0) {
    return <div style={{ fontSize: 13, color: "#9ca3af" }}>(no parameters)</div>;
  }

  return (
    <table style={{ fontSize: 13, borderCollapse: "collapse", width: "100%" }}>
      <tbody>
        {parameters.map((p) => (
          <tr key={p.name}>
            <td style={{ padding: "2px 12px 2px 0", fontFamily: "monospace", fontWeight: 600 }}>{p.name}</td>
            <td style={{ padding: "2px 12px 2px 0", color: "#6b7280" }}>{p.annotation ?? ""}</td>
            <td style={{ padding: "2px 12px 2px 0" }}>
              {p.required ? (
                <span style={{ color: "#dc2626" }}>required</span>
              ) : (
                <span style={{ color: "#6b7280" }}>= {p.default}</span>
              )}
            </td>
            <td style={{ padding: "2px 0", color: "#9ca3af" }}>{p.kind.replace(/_/g, " ")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

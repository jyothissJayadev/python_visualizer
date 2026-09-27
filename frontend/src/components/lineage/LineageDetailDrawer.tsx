import type { NodeDetailModal } from "../../lib/lineageStore";

interface Props {
  detail: NodeDetailModal | null;
  onClose: () => void;
}

export function LineageDetailDrawer({ detail, onClose }: Props) {
  if (!detail) return null;

  const typeLabels: Record<NodeDetailModal["type"], { label: string; color: string }> = {
    brain_endpoint: { label: "Brain Endpoint (FastAPI)", color: "#a855f7" },
    backend_service: { label: "Backend Service Client", color: "#3b82f6" },
    backend_controller: { label: "Backend Controller Handler", color: "#06b6d4" },
    backend_route: { label: "Express API Route", color: "#10b981" },
    client_api: { label: "Client API Function", color: "#f59e0b" },
    client_ui: { label: "React UI Component & Handler", color: "#ec4899" },
    note: { label: "Note / Context", color: "#64748b" },
  };

  const info = typeLabels[detail.type] || { label: detail.type, color: "#64748b" };

  return (
    <div className="lineage-drawer-backdrop" onClick={onClose}>
      <div className="lineage-drawer" onClick={(e) => e.stopPropagation()}>
        {/* Drawer Header */}
        <div className="lineage-drawer-header">
          <div className="drawer-title-group">
            <span
              className="drawer-type-badge"
              style={{ backgroundColor: `${info.color}22`, color: info.color, borderColor: `${info.color}55` }}
            >
              {info.label}
            </span>
            <h3 className="drawer-title">{detail.title}</h3>
            {detail.subtitle && <p className="drawer-subtitle">{detail.subtitle}</p>}
          </div>

          <button className="btn-icon drawer-close-btn" onClick={onClose} title="Close inspector">
            ✕
          </button>
        </div>

        {/* Drawer Body */}
        <div className="lineage-drawer-body">
          {/* File location */}
          {detail.file && (
            <div className="drawer-section">
              <div className="section-label">Source Location</div>
              <div className="file-location-box">
                <span className="file-icon">📄</span>
                <span className="file-path">{detail.file}</span>
                {detail.line && <span className="file-line">Line {detail.line}</span>}
              </div>
            </div>
          )}

          {/* Code Snippet */}
          {detail.snippet && (
            <div className="drawer-section">
              <div className="section-label">Code Context</div>
              <pre className="drawer-code-block">
                <code>{detail.snippet}</code>
              </pre>
            </div>
          )}

          {/* Raw Metadata */}
          {Boolean(detail.data) && (
            <div className="drawer-section">
              <div className="section-label">AST Node Metadata</div>
              <pre className="drawer-json-block">
                <code>{JSON.stringify(detail.data, null, 2)}</code>
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

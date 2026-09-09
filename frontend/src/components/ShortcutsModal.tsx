interface Props {
  open: boolean;
  onClose: () => void;
}

const ROWS: [string, React.ReactNode][] = [
  ["Focus Catalog Search", <kbd key="k">/</kbd>],
  ["Close Inspector / Modal", <kbd key="k">Esc</kbd>],
  [
    "Move Selection Down",
    <span key="k">
      <kbd>j</kbd> or <kbd>↓</kbd>
    </span>,
  ],
  [
    "Move Selection Up",
    <span key="k">
      <kbd>k</kbd> or <kbd>↑</kbd>
    </span>,
  ],
  ["Clear Stream", <kbd key="k">c</kbd>],
  ["Pause / Resume Stream", <kbd key="k">Space</kbd>],
  ["Toggle Left Catalog Rail", <kbd key="k">Ctrl+B</kbd>],
];

export function ShortcutsModal({ open, onClose }: Props) {
  return (
    <div
      className={"modal-overlay" + (open ? "" : " hidden")}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-card">
        <div className="modal-header">
          <span>Keyboard Shortcuts</span>
          <button className="btn-sm btn-icon" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          {ROWS.map(([label, keys], i) => (
            <div key={i} className="shortcut-row">
              <span>{label}</span>
              {keys}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

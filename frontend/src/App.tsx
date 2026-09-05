import { useState } from "react";
import { ExplorerPage } from "./pages/ExplorerPage";
import { TracesPage } from "./pages/TracesPage";

type Tab = "functions" | "traces";

function App() {
  const [tab, setTab] = useState<Tab>("functions");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <nav
        style={{
          display: "flex",
          gap: 4,
          padding: "6px 12px 0 12px",
          borderBottom: "1px solid #e5e7eb",
          background: "#fafafa",
        }}
      >
        {(["functions", "traces"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "8px 16px",
              border: "1px solid #e5e7eb",
              borderBottom: tab === t ? "2px solid #4f46e5" : "1px solid #e5e7eb",
              borderRadius: "6px 6px 0 0",
              background: tab === t ? "white" : "transparent",
              fontWeight: tab === t ? 700 : 400,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            {t === "functions" ? "Functions" : "Traces"}
          </button>
        ))}
      </nav>
      {tab === "functions" ? <ExplorerPage /> : <TracesPage />}
    </div>
  );
}

export default App;

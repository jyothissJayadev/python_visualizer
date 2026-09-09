import { useEffect, useState } from "react";
import { store } from "./lib/store";
import { startSocket } from "./lib/socket";
import { Toolbar } from "./components/Toolbar";
import { CatalogPane } from "./components/CatalogPane";
import { CatalogModal } from "./components/CatalogModal";
import { StreamPane } from "./components/StreamPane";
import { InspectorPane } from "./components/InspectorPane";
import { Toast } from "./components/Toast";

export default function App() {
  const [catalogCollapsed, setCatalogCollapsed] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [testDrawerOpen, setTestDrawerOpen] = useState(false);

  useEffect(() => {
    startSocket();
    void store.loadCatalog();
  }, []);

  const onSendTest = () => {
    setCatalogCollapsed(false);
    setTestDrawerOpen(true);
  };

  return (
    <div id="app">
      <Toolbar
        catalogCollapsed={catalogCollapsed}
        onToggleCatalog={() => setCatalogCollapsed((v) => !v)}
        onSendTest={onSendTest}
      />

      <div className="workspace-body">
        <CatalogPane
          collapsed={catalogCollapsed}
          onOpenModal={() => setModalOpen(true)}
          testDrawerOpen={testDrawerOpen}
          setTestDrawerOpen={setTestDrawerOpen}
        />
        <StreamPane onSendTest={onSendTest} />
        <InspectorPane />
      </div>

      <CatalogModal open={modalOpen} onClose={() => setModalOpen(false)} />
      <Toast />
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { store } from "./lib/store";
import { useTerminal } from "./lib/useTerminal";
import { startSocket } from "./lib/socket";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { Toolbar } from "./components/Toolbar";
import { CatalogPane } from "./components/CatalogPane";
import { CatalogModal } from "./components/CatalogModal";
import { StreamPane } from "./components/StreamPane";
import { InspectorPane } from "./components/InspectorPane";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { Toast } from "./components/Toast";

export default function App() {
  const s = useTerminal();
  const [catalogCollapsed, setCatalogCollapsed] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [testDrawerOpen, setTestDrawerOpen] = useState(false);

  useEffect(() => {
    startSocket();
    void store.loadCatalog();
  }, []);

  const onSendTest = () => {
    setCatalogCollapsed(false);
    setTestDrawerOpen(true);
  };

  const handlers = useMemo(
    () => ({
      modalOpen,
      shortcutsOpen,
      inspectorOpen: s.selectedSpanId != null,
      openModal: () => setModalOpen(true),
      closeModal: () => setModalOpen(false),
      closeShortcuts: () => setShortcutsOpen(false),
      toggleCatalog: () => setCatalogCollapsed((v) => !v),
    }),
    [modalOpen, shortcutsOpen, s.selectedSpanId],
  );
  useKeyboardShortcuts(handlers);

  return (
    <div id="app">
      <Toolbar
        catalogCollapsed={catalogCollapsed}
        onToggleCatalog={() => setCatalogCollapsed((v) => !v)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
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
      <ShortcutsModal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />
      <Toast />
    </div>
  );
}

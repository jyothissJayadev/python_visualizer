import { useEffect } from "react";
import { store } from "../lib/store";

interface Handlers {
  modalOpen: boolean;
  shortcutsOpen: boolean;
  openModal: () => void;
  closeModal: () => void;
  closeShortcuts: () => void;
  toggleCatalog: () => void;
  inspectorOpen: boolean;
}

export function useKeyboardShortcuts(h: Handlers) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      const typing = tag === "input" || tag === "textarea";

      if (e.key === "/" && !typing) {
        e.preventDefault();
        h.openModal();
        return;
      }
      if (e.key === "Escape") {
        if (h.modalOpen) {
          h.closeModal();
          return;
        }
        if (h.shortcutsOpen) {
          h.closeShortcuts();
          return;
        }
        if (h.inspectorOpen) {
          store.closeInspector();
          return;
        }
        if (typing) (document.activeElement as HTMLElement).blur();
        return;
      }
      if ((e.key === "c" || e.key === "C") && !typing) {
        e.preventDefault();
        store.clearStream();
        store.pushToast("Cleared stream");
        return;
      }
      if (e.key === " " && !typing) {
        e.preventDefault();
        store.togglePause();
        return;
      }
      if (e.ctrlKey && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        h.toggleCatalog();
        return;
      }
      if (
        (e.key === "j" ||
          e.key === "k" ||
          e.key === "ArrowDown" ||
          e.key === "ArrowUp") &&
        !typing
      ) {
        e.preventDefault();
        store.navigate(e.key === "j" || e.key === "ArrowDown" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [h]);
}

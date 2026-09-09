import { useEffect, useState } from "react";
import { store } from "../lib/store";
import { useTerminal } from "../lib/useTerminal";

export function Toast() {
  const { toast } = useTerminal();
  const [hiddenId, setHiddenId] = useState<number | null>(null);

  useEffect(() => {
    if (!toast) return;
    const hide = setTimeout(() => setHiddenId(toast.id), 2000);
    const drop = setTimeout(() => store.dismissToast(toast.id), 2200);
    return () => {
      clearTimeout(hide);
      clearTimeout(drop);
    };
  }, [toast]);

  const show = !!toast && toast.id !== hiddenId;
  return (
    <div className={"toast-pill" + (show ? " show" : "")}>{toast?.msg ?? ""}</div>
  );
}

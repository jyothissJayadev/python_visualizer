import { useEffect } from "react";
import { useInstance } from "../lib/instance";
import "../instance.css";

/** Names the target this dashboard is attached to (page title + a small corner badge). */
export function InstanceBadge() {
  const { name, project, loaded } = useInstance();
  useEffect(() => {
    document.title = name ? `${name} · Brain Terminal` : "Brain Terminal";
  }, [name]);
  if (!loaded || !name || name === "default") return null;
  return (
    <div className="instance-badge" title={project}>
      {name}
    </div>
  );
}

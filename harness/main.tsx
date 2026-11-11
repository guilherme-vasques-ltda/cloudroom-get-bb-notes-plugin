import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import "../app";

function Host() {
  const [path, setPath] = useState(location.pathname.slice(1));
  useEffect(() => {
    const on = () => setPath(location.pathname.slice(1));
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  const P = (window as any).__panel.component;
  return (
    <div data-bb-plugin="notes" style={{ display: "flex", height: "100vh" }}>
      <div style={{ width: 220, borderRight: "1px solid var(--border)", padding: 12, fontSize: 13, opacity: 0.8 }}>
        <div style={{ marginBottom: 8, fontWeight: 600 }}>(barra lateral simulada)</div>
        <div style={{ background: "var(--state-active)", padding: "4px 8px", borderRadius: 6 }}>📄 Notes</div>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <P subPath={path} />
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Host />);

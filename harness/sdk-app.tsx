// SDK de brincadeira (só para testes/capturas): fala com harness/run.mjs por HTTP.
import { useEffect, useMemo, useRef } from "react";

export function definePluginApp(cb: (app: any) => void) {
  cb({ slots: { navPanel: (r: any) => ((window as any).__panel = r) } });
  return null;
}
export function useRpc() {
  return useMemo(
    () => ({
      async call(method: string, input: unknown) {
        const r = await fetch(`/rpc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error);
        return j.result;
      },
    }),
    [],
  );
}
export function useRealtime(channel: string, handler: (p: unknown) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const es = new EventSource("/events");
    es.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.channel === channel) ref.current(m.payload);
    };
    return () => es.close();
  }, [channel]);
}
export function useBbNavigate() {
  return useMemo(
    () => ({
      toPluginPanel(_path: string, o?: { subPath?: string; replace?: boolean }) {
        history[o?.replace ? "replaceState" : "pushState"](null, "", "/" + (o?.subPath ?? ""));
        window.dispatchEvent(new PopStateEvent("popstate"));
      },
    }),
    [],
  );
}

export function useSdk() {
  return useMemo(() => ({ projects: { list: async () => [{ id: "p1", name: "Acme", isPersonal: false }, { id: "p2", name: "Orion", isPersonal: false }, { id: "p0", name: "Pessoal", isPersonal: true }] } }), []);
}
export function useBbContext() {
  return { projectId: new URLSearchParams(location.search).get("project") ?? null, threadId: null };
}

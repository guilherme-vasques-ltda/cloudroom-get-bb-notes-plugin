function show(kind: string, text: string) {
  let box = document.getElementById("toasts");
  if (!box) {
    box = document.createElement("div");
    box.id = "toasts";
    box.style.cssText = "position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;z-index:99999";
    document.body.append(box);
  }
  const t = document.createElement("div");
  t.textContent = text;
  t.style.cssText = `padding:10px 14px;border-radius:8px;font-size:13px;background:#222;color:#eee;border:1px solid ${kind === "error" ? "#ef4444" : "#3a3a3a"}`;
  box.append(t);
  setTimeout(() => t.remove(), 6000);
}
export const toast = Object.assign((m: string) => show("info", m), {
  error: (m: string) => show("error", m),
  success: (m: string) => show("ok", m),
});

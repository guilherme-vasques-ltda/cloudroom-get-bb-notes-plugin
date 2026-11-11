// Servidor de teste: roda o server.ts REAL com um "bb" de mentira e serve o app por HTTP.
import { createServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import plugin from "../server";

const ROOT = process.env.NOTES_ROOT ?? "";
const PORT = Number(process.env.PORT ?? 4321);
const handlers: Record<string, (i: any) => Promise<unknown>> = {};
const sse = new Set<ServerResponse>();
const bb: any = {
  log: { info: console.log, warn: console.warn, error: console.error, debug() {} },
  settings: { define: () => ({ get: async () => ({ root: ROOT, extraVaults: process.env.NOTES_EXTRA ?? "", readOnly: process.env.NOTES_READONLY === "1" }) }) },
  rpc: { register: (_c: unknown, h: typeof handlers) => Object.assign(handlers, h) },
  realtime: { publish: (channel: string, payload: unknown) => sse.forEach((r) => r.write(`data: ${JSON.stringify({ channel, payload })}\n\n`)) },
  background: { service: (_n: string, s: { start(sig: AbortSignal): unknown }) => void s.start(new AbortController().signal) },
  cli: { register() {} },
  onDispose() {},
};
await plugin(bb);
const files: Record<string, [string, string]> = {
  "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/app.css": ["app.css", "text/css"], "/theme.css": ["theme.css", "text/css"],
};
createServer(async (req, res) => {
  const url = req.url ?? "/";
  if (url === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    sse.add(res);
    req.on("close", () => sse.delete(res));
    return;
  }
  if (url.startsWith("/rpc/") && req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer); // Buffers inteiros: concatenar string quebra UTF-8 na fronteira do pedaço
    const body = Buffer.concat(chunks).toString("utf8");
    try {
      const result = await handlers[url.slice(5)]!(JSON.parse(body || "null"));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result }));
    } catch (e) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: (e as Error).message }));
    }
    return;
  }
  const f = files[url] ?? files["/"]!;
  res.writeHead(200, { "content-type": f[1] }).end(readFileSync(new URL(`./${f[0]}`, import.meta.url)));
}).listen(PORT, "127.0.0.1", () => console.log(`harness em http://127.0.0.1:${PORT} raiz=${ROOT}`));

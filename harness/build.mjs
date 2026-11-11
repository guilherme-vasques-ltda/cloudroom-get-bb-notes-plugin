import { build } from "esbuild";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
mkdirSync(`${root}/harness/dist`, { recursive: true });
await build({
  entryPoints: [`${root}/harness/main.tsx`], bundle: true, outfile: `${root}/harness/dist/app.js`, jsx: "automatic", format: "esm",
  alias: { "@get-bb/plugin-sdk/app": `${root}/harness/sdk-app.tsx`, sonner: `${root}/harness/sonner.ts`, "@": root },
  define: { "process.env.NODE_ENV": '"development"' }, logLevel: "warning",
});
await build({
  entryPoints: [`${root}/harness/run.ts`], bundle: true, outfile: `${root}/harness/dist/run.mjs`, platform: "node", format: "esm",
  alias: { "@get-bb/plugin-sdk": `${root}/harness/stub-sdk.ts` }, logLevel: "warning",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
copyFileSync(`${root}/dist/app.css`, `${root}/harness/dist/app.css`);
copyFileSync(`${root}/harness/theme.css`, `${root}/harness/dist/theme.css`);
writeFileSync(`${root}/harness/dist/index.html`, `<!doctype html><meta charset=utf-8><link rel=stylesheet href=/theme.css><link rel=stylesheet href=/app.css><div id=root></div><script type=module src=/app.js></script>`);
console.log("harness ok");

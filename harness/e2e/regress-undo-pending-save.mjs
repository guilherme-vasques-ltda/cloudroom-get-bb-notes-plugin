// Regressão: desfazer até o texto anterior enquanto uma gravação está em andamento e sair da nota
// não pode deixar no disco o texto intermediário (o último que estava na tela deve vencer).
import { open } from "./lib.mjs";
import { readFileSync } from "node:fs";
const H = "http://127.0.0.1:4321", R = process.env.NOTES_ROOT ?? "/tmp/notes-demo";
const { ctx, page } = await open(1500, 900);
let delayed = 0;
await page.route("**/rpc/write", async (route) => {
  if (delayed++ === 0) await new Promise((r) => setTimeout(r, 3000)); // só a 1ª gravação demora
  await route.continue();
});
const orig = readFileSync(`${R}/_testes/links.md`, "utf8");
await page.goto(`${H}/main/_testes/links.md`);
await page.click('button:has-text("Markdown")');
await page.waitForSelector("[data-testid=editor]");
await page.click("[data-testid=editor]");
await page.keyboard.press("Control+End");
await page.keyboard.type(" B-INTERMEDIARIO");
await page.waitForTimeout(1000); // autosave disparou (gravação atrasada em curso)
for (let i = 0; i < 40; i++) { await page.keyboard.press("Control+Z"); await page.keyboard.press("Meta+Z"); }
const shown = await page.inputValue("[data-testid=editor]");
await page.click("[role=treeitem] >> text=ideias.md"); // sai da nota antes da resposta
await page.waitForTimeout(6000);
const disk = readFileSync(`${R}/_testes/links.md`, "utf8");
console.log("tela antes de sair == original:", shown === orig);
console.log("disco == texto da tela (original):", disk === orig);
console.log("disco contém intermediário:", disk.includes("B-INTERMEDIARIO"));
await ctx.close();
process.exit(shown === orig && disk === orig ? 0 : 1);

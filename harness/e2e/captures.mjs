import { open } from "./lib.mjs";
import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const OUT = process.env.OUT ?? join(dirname(fileURLToPath(import.meta.url)), "../../docs/capturas");
mkdirSync(OUT, { recursive: true });
const H = "http://127.0.0.1:4321", R = process.env.NOTES_ROOT ?? "/tmp/notes-demo";
const { ctx, page } = await open(1500, 900);
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
const REL = "Pesquisa/Concorrentes/Exemplo SA/Relatorio.md";

await page.goto(`${H}/main/${enc(REL)}`);
await page.waitForSelector(".nt-editor .tiptap h1"); await page.waitForTimeout(500);
await shot("01-editor-formatado");

await page.click(".nt-editor .tiptap p >> nth=0"); await page.keyboard.press("End"); await page.keyboard.type(" (editado aqui)");
await page.waitForTimeout(1800); await shot("02-editado-salvo");

await page.click(".nt-editor .tiptap p >> nth=1"); await page.keyboard.press("End"); await page.keyboard.type(" MEU-TEXTO");
appendFileSync(`${R}/${REL}`, "\nLINHA-EXTERNA\n");
await page.waitForSelector("text=mudou no disco enquanto você editava", { timeout: 6000 }); await shot("03-conflito");
await page.click("text=Pegar o deles"); await page.waitForTimeout(800);

await page.click('button:has-text("Markdown")'); await page.waitForSelector("[data-testid=editor]"); await shot("04-modo-markdown");
await page.click('button:has-text("Formatado")');

await page.goto(`${H}/main/${enc("_testes/com-imagem.md")}`);
await page.waitForSelector(".nt-editor .tiptap table"); await page.waitForSelector(".nt-editor .tiptap img[src^='data:']"); await shot("05-imagem-tabela");

await page.goto(`${H}/main/${enc("_testes/pagina.html")}`);
await page.waitForSelector("iframe"); await page.waitForTimeout(800); await shot("06-html-isolado-sem-scripts");

await page.goto(`${H}/main`);
await page.fill('input[aria-label="Buscar"]', "worktree"); await page.waitForTimeout(900); await shot("07-busca");
await page.fill('input[aria-label="Buscar"]', "");

await page.goto(`${H}/main/${enc("ideias.md")}`);
await page.waitForSelector(".nt-editor .tiptap h1");
await page.locator("[role=treeitem]", { hasText: "Orion" }).first().click({ button: "right" });
await page.waitForTimeout(400); await shot("08-menu-botao-direito-pasta");
await page.keyboard.press("Escape");
await ctx.close();

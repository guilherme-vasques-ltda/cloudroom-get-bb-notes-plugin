// Separa o cabeçalho YAML (--- ... ---) do corpo. O cabeçalho NUNCA passa pelo editor
// visual: é devolvido byte a byte ao salvar. O BOM UTF-8 (U+FEFF) também é metadado do arquivo:
// fica no "cabeçalho" e nunca entra no texto editável. Escrito do zero (sem dependência de YAML).
export function parseMarkdownDocument(content: string): { frontmatter: string; body: string } {
  const bom = content.startsWith("﻿") ? "﻿" : "";
  const start = bom.length;
  const first = /^---[ \t]*\r?\n/.exec(content.slice(start));
  if (first === null) return { frontmatter: bom, body: content.slice(start) };
  let pos = start + first[0].length;
  while (pos < content.length) {
    const nl = content.indexOf("\n", pos);
    const end = nl === -1 ? content.length : nl;
    const line = content.slice(pos, content[end - 1] === "\r" ? end - 1 : end);
    const next = nl === -1 ? content.length : nl + 1;
    if (line === "---" || line === "...") {
      return { frontmatter: content.slice(0, next), body: content.slice(next) };
    }
    if (next === pos) break;
    pos = next;
  }
  return { frontmatter: bom, body: content.slice(start) };
}

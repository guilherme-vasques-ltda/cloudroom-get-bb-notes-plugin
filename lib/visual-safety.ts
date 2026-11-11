// Sintaxes que o editor formatado (Tiptap) reescreveria ao editar o bloco que as contém.
// Notas com qualquer uma delas abrem só em modo Markdown (texto cru, sem reescrita).
const RULES: RegExp[] = [
  /\[\^[^\]\s]+\](?!\()/, // nota de rodapé [^1]
  /\[\[[^\]\n]+\]\]/, // [[wikilink]] e ![[embed]]
  /^\s*>\s*\[![A-Za-z]+\]/m, // callout > [!note]
  /\^\[[^\]\n]+\]/, // nota inline ^[...]
  /\]\([^)\n]*\s["'(]/, // link com título: ](url "t"), ](url 't'), ](url (t)), ](<a b.md> "t")
  /^[ \t>]*\[[^\]\n]+\]:[ \t]*\S+[ \t]+["'(]/m, // definição de link com título: [r]: url "t"
  /<file:/i, // autolink <file:///x>
  /\$\$/, // bloco de matemática $$…$$
  /\]\(file:/i, // file://
  /^[ \t>]*(`{3,}|~{3,})[^\s`]*[ \t]+\S/m, // cerca de código com atributos (c# title=x, {r, echo=FALSE}, …)
  /(?<![\w$])\$(?=[^\s$])[^$\n]*[*_^\\][^$\n]*[^\s$\\]\$(?![\w$])/, // matemática $a*b$ (preços como "US$ 5 e US$ 6" não casam)
];

/** Linha de alinhamento de tabela (tem ":" e "-"), com ou sem barras nas pontas. */
function hasAlignedTable(text: string): boolean {
  return text.split(/\r?\n/).some((l) => /^[ \t>]*[|:-][ \t|:-]*$/.test(l) && l.includes(":") && l.includes("-"));
}

export function needsMarkdownMode(text: string): boolean {
  return RULES.some((r) => r.test(text)) || hasAlignedTable(text);
}

import { describe, expect, it } from "vitest";
import { needsMarkdownMode } from "../lib/visual-safety";

describe("needsMarkdownMode", () => {
  it.each([
    "texto[^1]\n\n[^1]: nota",
    "veja [[Nota]]",
    "![[img.png]]",
    "> [!note]\n> x",
    "um ^[nota inline] aqui",
    "[t](a.md 'Título')",
    '[t](a.md "Título")',
    "[t](a.md (Título))",
    "[f](file:///x)",
    "````python title=\"x\"\ncode\n````",
    "```python title=\"x\"\ncode\n```",
    "conta $a*b$ e fim",
    "| a | b |\n| :--- | ---: |\n| 1 | 2 |",
    "a | b\n:--- | ---\n1 | 2",
    "| a | b |\r\n| :--- | ---: |\r\n| 1 | 2 |\r\n",
    "> | a | b |\n> | :--- | ---: |",
    "[t](<a b.md> \"Título\")",
    "veja [t][r]\n\n[r]: a.md \"Título\"",
    "$$\na*b\n$$",
    "```c# title=x\ncode\n```",
    "```{r, echo=FALSE}\ncode\n```",
    "<file:///x>",
  ])("abre só em Markdown: %j", (t) => expect(needsMarkdownMode(t)).toBe(true));

  it.each([
    "# Título\n\ntexto normal com [link](Pasta/a.md) e **negrito**",
    "```python\nprint(1)\n```\n\ntexto depois",
    "```\ncódigo\n```\nlinha logo abaixo",
    "custa US$ 5 e US$ 6 no total",
    "R$ 10,00 + R$ 20,00",
    "| a | b |\n| --- | --- |\n| 1 | 2 |",
    "- [ ] tarefa\n- [x] feita",
    "<div>html cru</div>",
    "veja <https://a.com> e [link](a.md)",
    "```js\ncode\n```\n\n[r]: a.md",
  ])("segue no editor formatado: %j", (t) => expect(needsMarkdownMode(t)).toBe(false));
});

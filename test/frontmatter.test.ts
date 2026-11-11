import { describe, expect, it } from "vitest";
import { parseMarkdownDocument } from "../lib/frontmatter";

describe("parseMarkdownDocument", () => {
  it("BOM sem frontmatter: o BOM fica fora do texto editável e volta ao juntar", () => {
    const doc = "\uFEFF# Título\n";
    const p = parseMarkdownDocument(doc);
    expect(p.body).toBe("# Título\n");
    expect(p.frontmatter + p.body).toBe(doc);
  });
  it("frontmatter + BOM: cabeçalho devolvido byte a byte", () => {
    const doc = "\uFEFF---\ntitle: x\n---\n# T\n";
    const p = parseMarkdownDocument(doc);
    expect(p.frontmatter + p.body).toBe(doc);
    expect(p.body).toBe("# T\n");
  });
  it("sem frontmatter nem BOM: tudo é corpo", () => {
    expect(parseMarkdownDocument("# T\n")).toEqual({ frontmatter: "", body: "# T\n" });
  });
  it("cabeçalho não fechado vira corpo (nada se perde)", () => {
    const doc = "---\ntitle: x\n# T\n";
    const p = parseMarkdownDocument(doc);
    expect(p.frontmatter + p.body).toBe(doc);
  });
});

import { describe, expect, it } from "vitest";
import { isAllowedLink } from "../lib/link-policy";

// imita o validador padrão do Tiptap: só http(s), mailto, tel
const dv = (u: string) => /^(https?:|mailto:|tel:)/i.test(u);

describe("isAllowedLink", () => {
  it.each(["Orion/plano.md", "../x.md", "a b.md", "#ancora", "https://a.com", "mailto:a@b.c", "obsidian://open?vault=x", "file:///x"])("aceita %j", (u) => {
    expect(isAllowedLink(u, dv)).toBe(true);
  });
  it.each(["javascript:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "java\nscript:alert(1)", "\u0001javascript:alert(1)", "JaVaScRiPt:x", "data:text/html,<b>", "vbscript:x"])("recusa %j", (u) => {
    expect(isAllowedLink(u, dv)).toBe(false);
  });
});

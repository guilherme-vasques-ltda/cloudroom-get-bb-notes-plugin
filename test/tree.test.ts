import { describe, expect, it } from "vitest";
import { decodeNoteSubPath, encodeNoteSubPath } from "../lib/tree";

const ids = ["main", "v2"];

describe("caminho na URL (base64url)", () => {
  it.each([
    "Pasta Exemplo/Subpasta/Nota.md",
    "docs/Concorrentes/Exemplo SA/Relatorio.md",
    "100% pronto #1 ? sim & não.md",
    "a%20b/%C3%A1.md", // % literal no nome
    "日本語/メモ.md",
    "emoji 🍊/nota.md",
    "x.md",
  ])("ida e volta: %s", (path) => {
    const sub = encodeNoteSubPath("main", path);
    expect(sub).toMatch(/^main\/p\.[A-Za-z0-9_-]+$/); // nada que a camada de rotas possa alterar
    expect(decodeNoteSubPath(sub, ids)).toEqual({ vault: "main", path });
  });

  it("sobrevive a codificação/decodificação extra pela camada de rotas", () => {
    const sub = encodeNoteSubPath("v2", "Pasta com espaço/Análise.md");
    expect(decodeNoteSubPath(encodeURIComponent(sub).replace(/%2F/g, "/"), ids).path).toBe("Pasta com espaço/Análise.md");
    expect(decodeNoteSubPath(decodeURIComponent(sub), ids).path).toBe("Pasta com espaço/Análise.md");
  });

  it("raiz do cofre: só o id", () => {
    expect(encodeNoteSubPath("main", "")).toBe("main");
    expect(decodeNoteSubPath("main", ids)).toEqual({ vault: "main", path: "" });
  });

  it("links antigos (caminho em claro) ainda abrem", () => {
    expect(decodeNoteSubPath("main/Pasta%20Exemplo/Subpasta/Nota.md", ids)).toEqual({
      vault: "main",
      path: "Pasta Exemplo/Subpasta/Nota.md",
    });
    expect(decodeNoteSubPath("docs/a.md", ids)).toEqual({ vault: null, path: "docs/a.md" });
  });
});

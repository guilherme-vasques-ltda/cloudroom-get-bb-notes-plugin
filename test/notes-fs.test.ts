import { chmodSync, statSync, linkSync, mkdirSync, mkdtempSync, readFileSync, existsSync, renameSync, symlinkSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { NotesError, NotesStore, buildSandboxedHtml, sha256 } from "../lib/notes-fs";

let base: string;
let root: string;
let outside: string;
let store: NotesStore;

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof NotesError) return e.code;
    throw e;
  }
  return "no-error";
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "notes-test-"));
  root = join(base, "cofre");
  outside = join(base, "fora");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, "segredo.md"), "TOP SECRET");
  mkdirSync(join(root, "pasta"));
  writeFileSync(join(root, "a.md"), "# A\n");
  writeFileSync(join(root, "pasta", "b.md"), "bbb\n");
  store = new NotesStore(root);
});

describe("path traversal / restrição à raiz", () => {
  it.each(["../fora/segredo.md", "pasta/../../fora/segredo.md", "..", "a/../../x", "/etc/passwd", "C:/x", "a\\b", "a\0b"])(
    "rejeita %j em leitura",
    (p) => {
      expect(["bad_path", "outside_root"]).toContain(code(() => store.read(p)));
    },
  );

  it("rejeita ../ também em escrita, criação, renomeação e lixeira", () => {
    expect(code(() => store.write("../fora/segredo.md", "x", "h"))).toBe("bad_path");
    expect(code(() => store.create("../fora/novo.md", "file"))).toBe("bad_path");
    expect(code(() => store.rename("a.md", "../fora/a.md"))).toBe("bad_path");
    expect(code(() => store.rename("../fora/segredo.md", "x.md"))).toBe("bad_path");
    expect(code(() => store.trash("../fora/segredo.md", true))).toBe("bad_path");
    expect(readFileSync(join(outside, "segredo.md"), "utf8")).toBe("TOP SECRET");
    expect(existsSync(join(outside, "novo.md"))).toBe(false);
  });

  it("symlink de arquivo apontando para fora: não lê, não grava, não aparece na árvore", () => {
    symlinkSync(join(outside, "segredo.md"), join(root, "link.md"));
    expect(code(() => store.read("link.md"))).toBe("outside_root");
    expect(code(() => store.write("link.md", "hack", sha256("TOP SECRET")))).toBe("outside_root");
    expect(store.tree().entries.map((e) => e.path)).not.toContain("link.md");
    expect(readFileSync(join(outside, "segredo.md"), "utf8")).toBe("TOP SECRET");
  });

  it("symlink de pasta para fora: bloqueia caminhos que passam por ele (leitura e criação)", () => {
    symlinkSync(outside, join(root, "atalho"));
    expect(code(() => store.read("atalho/segredo.md"))).toBe("outside_root");
    expect(code(() => store.create("atalho/novo.md", "file"))).toBe("outside_root");
    expect(existsSync(join(outside, "novo.md"))).toBe(false);
    expect(store.tree().entries.map((e) => e.path).some((p) => p.startsWith("atalho"))).toBe(false);
  });

  it("symlink que aponta para dentro da raiz continua funcionando", () => {
    symlinkSync(join(root, "pasta"), join(root, "interno"));
    expect(store.read("interno/b.md").content).toBe("bbb\n");
  });

  it("segmentos ocultos (.git, .env, .lixeira) são inacessíveis", () => {
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".env"), "SEGREDO=1");
    expect(code(() => store.read(".env"))).toBe("bad_path");
    expect(code(() => store.read(".git/config"))).toBe("bad_path");
    expect(code(() => store.read(".lixeira/x"))).toBe("bad_path");
    expect(store.tree().entries.map((e) => e.name)).not.toContain(".env");
  });

  it("asset: só imagens; HTML não consegue puxar arquivo de fora nem texto como imagem", () => {
    expect(code(() => store.readAsset("a.md"))).toBe("not_text");
    writeFileSync(join(root, "p.html"), '<img src="../fora/segredo.png"><img src="../../x.png">');
    const out = buildSandboxedHtml(store, "p.html", readFileSync(join(root, "p.html"), "utf8"), );
    expect(out).not.toContain("base64");
    expect(out).toContain("Content-Security-Policy");
    expect(out).toContain("script-src 'none'");
  });

  it("HTML: assets relativos dentro da raiz viram data: URL; link externo de CSS é removido", () => {
    writeFileSync(join(root, "pasta", "i.png"), Buffer.from([137, 80, 78, 71]));
    writeFileSync(join(root, "pasta", "s.css"), "body{color:red}");
    const html = '<link rel="stylesheet" href="s.css"><link rel="stylesheet" href="https://evil.test/x.css"><img src="i.png">';
    const out = buildSandboxedHtml(store, "pasta/p.html", html, );
    expect(out).toContain("data:image/png;base64,");
    expect(out).toContain("<style>body{color:red}</style>");
    expect(out).not.toContain("evil.test");
    expect(buildSandboxedHtml(store, "pasta/p.html", "<p>x</p>")).toContain("script-src 'none'");
  });
});

describe("conflito (hash) antes de gravar", () => {
  it("grava quando o hash confere e atualiza o hash", () => {
    const r = store.read("a.md");
    const w = store.write("a.md", "# A2\n", r.hash);
    expect(w.status).toBe("ok");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# A2\n");
    if (w.status === "ok") expect(w.hash).toBe(sha256("# A2\n"));
  });

  it("NÃO grava e devolve a versão deles quando o arquivo mudou por fora", () => {
    const r = store.read("a.md");
    writeFileSync(join(root, "a.md"), "# alterado por outro\n");
    const w = store.write("a.md", "# meu\n", r.hash);
    expect(w.status).toBe("conflict");
    if (w.status === "conflict") {
      expect(w.currentContent).toBe("# alterado por outro\n");
      expect(w.currentHash).toBe(sha256("# alterado por outro\n"));
    }
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# alterado por outro\n");
  });

  it("'manter o meu' sobrescreve mas guarda a versão deles na lixeira (conflitos)", () => {
    const r = store.read("a.md");
    writeFileSync(join(root, "a.md"), "versão deles\n");
    const c = store.write("a.md", "versão minha\n", r.hash);
    expect(c.status).toBe("conflict");
    if (c.status !== "conflict") return;
    const k = store.writeKeepMine("a.md", "versão minha\n", c.currentHash);
    expect(k.status).toBe("ok");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("versão minha\n");
    const saved = store.listTrash().filter((t) => t.id.startsWith("conflitos/"));
    expect(saved.length).toBe(1);
    const id = saved[0]!.id;
    expect(readFileSync(join(root, ".lixeira", id, "a.md"), "utf8")).toBe("versão deles\n");
  });

  it("'manter o meu' vira conflito de novo se mudou outra vez enquanto decidia", () => {
    const r = store.read("a.md");
    writeFileSync(join(root, "a.md"), "v2\n");
    writeFileSync(join(root, "a.md"), "v3\n");
    const k = store.writeKeepMine("a.md", "meu\n", sha256("v2\n"));
    expect(k.status).toBe("conflict");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("v3\n");
    expect(r.hash).not.toBe(sha256("v3\n"));
  });

  it("arquivo apagado por fora: não recria", () => {
    const r = store.read("a.md");
    // mover para fora do cofre simula apagar por fora
    writeFileSync(join(base, "tmp"), "");
    renameSync(join(root, "a.md"), join(base, "a-movido.md"));
    expect(store.write("a.md", "x", r.hash).status).toBe("missing");
    expect(existsSync(join(root, "a.md"))).toBe(false);
  });

  it("gravação atômica não deixa temporários e preserva UTF-8/CRLF", () => {
    const text = "olá — ação\r\nlinha 2\r\n";
    writeFileSync(join(root, "c.md"), "x");
    const r = store.read("c.md");
    store.write("c.md", text, r.hash);
    expect(readFileSync(join(root, "c.md"), "utf8")).toBe(text);
    expect(readdirSync(root).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("arquivo que não é UTF-8 vira somente leitura (não corrompe)", () => {
    writeFileSync(join(root, "bin.md"), Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]));
    const r = store.read("bin.md");
    expect(r.content).toBeNull();
    expect(r.reason).toBe("binary");
  });
});

describe("nunca apagar sem confirmação e sem lixeira", () => {
  it.each([undefined, false, "true", 1, null])("recusa confirm=%j e o arquivo continua lá", (c) => {
    expect(code(() => store.trash("a.md", c))).toBe("not_confirmed");
    expect(existsSync(join(root, "a.md"))).toBe(true);
  });

  it("com confirmação, MOVE para .lixeira (o conteúdo continua existindo) e dá para restaurar", () => {
    const res = store.trash("a.md", true);
    expect(existsSync(join(root, "a.md"))).toBe(false);
    expect(readFileSync(join(root, ".lixeira", res.trashId, "a.md"), "utf8")).toBe("# A\n");
    expect(store.listTrash().some((t) => t.id === res.trashId && t.path === "a.md")).toBe(true);
    expect(store.tree().entries.map((e) => e.path)).not.toContain(".lixeira");
    store.restore(res.trashId, "a.md");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# A\n");
  });

  it("pasta inteira vai para a lixeira com tudo dentro", () => {
    const res = store.trash("pasta", true);
    expect(readFileSync(join(root, ".lixeira", res.trashId, "pasta", "b.md"), "utf8")).toBe("bbb\n");
    expect(existsSync(join(root, "pasta"))).toBe(false);
  });

  it("restaurar não sobrescreve nem aceita id/caminho malicioso", () => {
    const res = store.trash("a.md", true);
    writeFileSync(join(root, "a.md"), "novo\n");
    expect(code(() => store.restore(res.trashId, "a.md"))).toBe("exists");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("novo\n");
    expect(code(() => store.restore("../..", "a.md"))).toBe("bad_path");
    expect(code(() => store.restore(res.trashId, "../x"))).toBe("bad_path");
  });

  it("o módulo não expõe nenhuma operação de apagar de verdade", () => {
    const methods = Object.getOwnPropertyNames(NotesStore.prototype);
    expect(methods.filter((m) => /delete|remove|unlink|rm|erase/i.test(m))).toEqual([]);
  });
});

describe("criar / renomear / mover", () => {
  it("cria arquivo e pasta; não sobrescreve existente", () => {
    store.create("novo/dir/x.md", "file", "oi");
    expect(readFileSync(join(root, "novo", "dir", "x.md"), "utf8")).toBe("oi");
    store.create("outra", "dir");
    expect(code(() => store.create("a.md", "file", "sobrescrever"))).toBe("exists");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# A\n");
  });

  it("renomeia, move e recusa destino ocupado ou pasta dentro de si mesma", () => {
    store.rename("a.md", "pasta/a2.md");
    expect(existsSync(join(root, "pasta", "a2.md"))).toBe(true);
    expect(code(() => store.rename("pasta/a2.md", "pasta/b.md"))).toBe("exists");
    expect(code(() => store.rename("pasta", "pasta/sub"))).toBe("invalid_move");
    expect(readFileSync(join(root, "pasta", "b.md"), "utf8")).toBe("bbb\n");
  });
});

describe("árvore e busca", () => {
  it("lista pastas e arquivos com tipo, ignora ocultos", () => {
    writeFileSync(join(root, ".oculto.md"), "x");
    const paths = store.tree().entries.map((e) => `${e.type}:${e.path}`);
    expect(paths).toContain("dir:pasta");
    expect(paths).toContain("file:pasta/b.md");
    expect(paths.join()).not.toContain(".oculto");
  });

  it("busca por nome e por conteúdo", () => {
    const byName = store.search("pasta", false);
    expect(byName.some((h) => h.path === "pasta")).toBe(true);
    const byContent = store.search("bbb", true);
    expect(byContent.find((h) => h.path === "pasta/b.md")?.snippets[0]?.line).toBe(1);
    expect(store.search("bbb", false)).toEqual([]);
  });
});

describe("raiz", () => {
  it("raiz vazia ou inexistente falha com erro claro (nunca assume ~/Notes)", () => {
    expect(code(() => new NotesStore(""))).toBe("root_missing");
    expect(code(() => new NotesStore(join(base, "nao-existe")))).toBe("root_missing");
  });
});

describe("versões e imagens", () => {
  it("snapshot guarda a versão anterior em .lixeira/versoes antes de gravar", () => {
    const r = store.read("a.md");
    const w = store.write("a.md", "# novo\n", r.hash, { snapshot: true });
    expect(w.status).toBe("ok");
    const v = store.listTrash().filter((t) => t.id.startsWith("versoes/"));
    expect(v.length).toBe(1);
    expect(readFileSync(join(root, ".lixeira", v[0]!.id, "a.md"), "utf8")).toBe("# A\n");
    // restaurar uma versão não sobrescreve o arquivo atual: volta ao lado, com nome novo
    const back = store.restore(v[0]!.id, "a.md");
    expect(back.path).toMatch(/^a \(versão .*\)\.md$/);
    expect(readFileSync(join(root, back.path), "utf8")).toBe("# A\n");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# novo\n");
  });

  it("saveImage grava em _attachments sem sobrescrever e recusa o que não é imagem", () => {
    const png = Buffer.from([137, 80, 78, 71]);
    const a = store.saveImage("pasta/b.md", "Foto Legal!.png", png);
    const b = store.saveImage("pasta/b.md", "Foto Legal!.png", png);
    expect(a.path).not.toBe(b.path);
    expect(existsSync(join(root, "pasta", a.path))).toBe(true);
    expect(code(() => store.saveImage("pasta/b.md", "x.sh", png))).toBe("not_text");
    expect(code(() => store.saveImage("../fora/x.md", "x.png", png))).toBe("bad_path");
    expect(store.readAsset(`pasta/${a.path}`).mime).toBe("image/png");
  });
});

describe("regressões da revisão (Codex #1)", () => {
  it("lixeira que é symlink para fora: não grava, não lista, não restaura", () => {
    symlinkSync(outside, join(root, ".lixeira"));
    expect(code(() => store.trash("a.md", true))).toBe("outside_root");
    expect(existsSync(join(root, "a.md"))).toBe(true);
    const r = store.read("a.md");
    expect(code(() => store.write("a.md", "novo\n", r.hash, { snapshot: true }))).toBe("outside_root");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# A\n");
    writeFileSync(join(outside, "x.md"), "externo");
    expect(store.listTrash()).toEqual([]);
    expect(code(() => store.restore("abc", "x.md"))).toBe("outside_root");
    expect(readdirSync(outside).sort()).toEqual(["segredo.md", "x.md"]);
  });

  it("bucket intermediário da lixeira como symlink é recusado", () => {
    mkdirSync(join(root, ".lixeira"));
    symlinkSync(outside, join(root, ".lixeira", "versoes"));
    const r = store.read("a.md");
    expect(code(() => store.write("a.md", "novo\n", r.hash, { snapshot: true }))).toBe("outside_root");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# A\n");
    expect(readdirSync(outside)).toEqual(["segredo.md"]);
  });

  it("edição externa entre a leitura e o commit NÃO é sobrescrita (recheca o hash antes do rename)", () => {
    const r = store.read("a.md");
    writeFileSync(join(root, "a.md"), "edição externa\n"); // depois da leitura do editor
    const res = (store as any).commitIfUnchanged(join(store.root, "a.md"), "meu texto\n", r.hash);
    expect(res.status).toBe("conflict");
    expect(res.currentContent).toBe("edição externa\n");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("edição externa\n");
    expect(readdirSync(root).filter((n) => n.includes(".tmp-") || n.includes(".hold-"))).toEqual([]);
  });

  it("o arquivo original nunca é movido: nenhum retido/temporário sobra e o inode muda só no rename final", () => {
    const r = store.read("a.md");
    const w = store.write("a.md", "novo\n", r.hash, { snapshot: true });
    expect(w.status).toBe("ok");
    expect(readdirSync(root).filter((n) => n.includes(".tmp-") || n.includes(".hold-"))).toEqual([]);
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("novo\n");
  });

  it("a cópia de segurança é independente: alterar um hardlink do original depois não a muda", () => {
    linkSync(join(root, "a.md"), join(root, "alias-duro.md"));
    const r = store.read("a.md");
    store.write("a.md", "novo\n", r.hash, { snapshot: true });
    const saved = store.listTrash().find((t) => t.id.startsWith("versoes/"))!;
    writeFileSync(join(root, "alias-duro.md"), "alterado depois pelo outro nome");
    expect(readFileSync(join(root, ".lixeira", saved.id, "a.md"), "utf8")).toBe("# A\n");
  });

  it("manifesto da lixeira: symlink e caminho malicioso são ignorados (nada é lido fora)", () => {
    writeFileSync(join(outside, "evil.json"), JSON.stringify({ path: "segredo.md" }));
    mkdirSync(join(root, ".lixeira", "bucket1"), { recursive: true });
    symlinkSync(join(outside, "evil.json"), join(root, ".lixeira", "bucket1", ".item.json"));
    mkdirSync(join(root, ".lixeira", "bucket2"), { recursive: true });
    writeFileSync(join(root, ".lixeira", "bucket2", ".item.json"), JSON.stringify({ path: "../../../fora/segredo.md" }));
    expect(store.listTrash()).toEqual([]);
  });

  it("mover pasta para destino que já existe (mesmo vazio) é recusado e nada muda", () => {
    mkdirSync(join(root, "vazia"));
    expect(code(() => (store as any).moveNoClobber(join(store.root, "pasta"), join(store.root, "vazia")))).toBe("exists");
    expect(existsSync(join(root, "pasta", "b.md"))).toBe(true);
    expect(existsSync(join(root, "vazia"))).toBe(true);
  });

  it("mover/restaurar nunca sobrescreve: destino criado na corrida preserva o conteúdo", () => {
    writeFileSync(join(root, "alvo.md"), "alvo original");
    expect(code(() => (store as any).moveNoClobber(join(store.root, "a.md"), join(store.root, "alvo.md")))).toBe("exists");
    expect(readFileSync(join(root, "alvo.md"), "utf8")).toBe("alvo original");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# A\n");
  });

  it("lixeira lista o caminho real removido (subpasta) e restaura por ele", () => {
    const res = store.trash("pasta/b.md", true);
    const item = store.listTrash().find((t) => t.id === res.trashId)!;
    expect(item.path).toBe("pasta/b.md");
    store.restore(item.id, item.path);
    expect(readFileSync(join(root, "pasta", "b.md"), "utf8")).toBe("bbb\n");
  });

  it("não move nem remove o próprio symlink; alias para oculto é recusado", () => {
    symlinkSync(join(root, "a.md"), join(root, "alias.md"));
    expect(code(() => store.trash("alias.md", true))).toBe("invalid_move");
    expect(code(() => store.rename("alias.md", "x.md"))).toBe("invalid_move");
    expect(existsSync(join(root, "a.md"))).toBe(true);
    writeFileSync(join(root, ".env"), "SEGREDO");
    symlinkSync(join(root, ".env"), join(root, "visivel.md"));
    expect(code(() => store.read("visivel.md"))).toBe("bad_path");
  });

  it("manter o meu respeita tamanho e tipo editável", () => {
    writeFileSync(join(root, "img.png"), Buffer.from([137, 80]));
    const h = sha256(readFileSync(join(root, "img.png")));
    expect(code(() => store.writeKeepMine("img.png", "texto", h))).toBe("not_text");
    const r = store.read("a.md");
    expect(code(() => store.writeKeepMine("a.md", "é".repeat(3_000_000), r.hash))).toBe("too_large");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# A\n");
  });

  it("preserva BOM UTF-8 ao ler e gravar", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# com bom\n")]);
    writeFileSync(join(root, "bom.md"), bytes);
    const r = store.read("bom.md");
    expect(r.content!.startsWith("﻿")).toBe(true);
    store.write("bom.md", r.content! + "mais\n", r.hash);
    expect(readFileSync(join(root, "bom.md")).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });
});

describe("regressões da revisão (Fable)", () => {
  it("saveConflictCopy guarda o texto descartado em conflitos, com a permissão da nota", () => {
    chmodSync(join(root, "a.md"), 0o600);
    const r = store.saveConflictCopy("a.md", "meu texto descartado\n");
    expect(r.id.startsWith("conflitos/")).toBe(true);
    const p = join(root, ".lixeira", r.id, "a.md");
    expect(readFileSync(p, "utf8")).toBe("meu texto descartado\n");
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("arquivo protegido contra escrita (0444) não é sobrescrito", () => {
    chmodSync(join(root, "a.md"), 0o444);
    const r = store.read("a.md");
    expect(code(() => store.write("a.md", "x\n", r.hash))).toBe("read_only");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# A\n");
  });

  it("restore recusa id que é só o nome do bucket", () => {
    expect(code(() => store.restore("versoes", "a.md"))).toBe("bad_path");
    expect(code(() => store.restore("conflitos", "a.md"))).toBe("bad_path");
  });

  it("falha depois da checagem não deixa cópia de segurança (snapshot só no commit)", () => {
    chmodSync(join(root, "pasta"), 0o555); // sem permissão para criar o temporário
    const r = store.read("pasta/b.md");
    expect(() => store.write("pasta/b.md", "novo\n", r.hash, { snapshot: true })).toThrow();
    chmodSync(join(root, "pasta"), 0o755);
    expect(store.listTrash().filter((t) => t.id.startsWith("versoes/"))).toEqual([]);
    expect(readFileSync(join(root, "pasta", "b.md"), "utf8")).toBe("bbb\n");
  });
});

describe("regressões da conferência final (Fable)", () => {
  it("A3: edição externa durante a cópia de segurança vira conflito (hash relido antes do rename)", () => {
    const r = store.read("a.md");
    const orig = (store as any).backupCopy.bind(store);
    (store as any).backupCopy = (...args: unknown[]) => {
      orig(...args);
      writeFileSync(join(root, "a.md"), "editado durante a cópia\n");
    };
    const w = store.write("a.md", "meu\n", r.hash, { snapshot: true });
    expect(w.status).toBe("conflict");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("editado durante a cópia\n");
  });

  it("B4: arquivo protegido (0444) ainda permite guardar o texto descartado em conflitos", () => {
    chmodSync(join(root, "a.md"), 0o444);
    const r = store.saveConflictCopy("a.md", "meu texto\n");
    expect(readFileSync(join(root, ".lixeira", r.id, "a.md"), "utf8")).toBe("meu texto\n");
  });
});

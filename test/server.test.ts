import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import plugin, { parseVaults, rpcContract } from "../server";

type Handlers = Record<string, (i: any) => Promise<any>>;

async function boot(root: string, readOnly: boolean, listeners?: Array<(n: any) => void>) {
  const handlers: Handlers = {};
  const bb: any = {
    log: { info() {}, warn() {}, error() {}, debug() {} },
    settings: { define: () => ({ get: async () => ({ root, extraVaults: "", readOnly }), onChange: (l: (n: any) => void) => listeners?.push(l) }) },
    rpc: { register: (_c: unknown, h: Handlers) => Object.assign(handlers, h) },
    realtime: { publish() {} },
    background: { service() {} },
    cli: { register() {} },
    onDispose() {},
  };
  await plugin(bb);
  return handlers;
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "notes-srv-"));
  mkdirSync(join(root, "p"));
  writeFileSync(join(root, "a.md"), "# A\n");
  return root;
}

describe("contrato RPC", () => {
  it("trash só aceita confirm === true (sem confirmação nem passa pela validação)", () => {
    const schema = (rpcContract as any).trash.input;
    expect(schema.safeParse({ vault: "main", path: "a.md" }).success).toBe(false);
    expect(schema.safeParse({ vault: "main", path: "a.md", confirm: false }).success).toBe(false);
    expect(schema.safeParse({ vault: "main", path: "a.md", confirm: "true" }).success).toBe(false);
    expect(schema.safeParse({ vault: "main", path: "a.md", confirm: true }).success).toBe(true);
  });
  it("não existe nenhum método RPC de apagar", () => {
    expect(Object.keys(rpcContract).filter((k) => /delete|remove|unlink|erase/i.test(k))).toEqual([]);
  });
});

describe("somente leitura", () => {
  it("bloqueia todas as operações que escrevem e não altera o disco", async () => {
    const root = makeRoot();
    const h = await boot(root, true);
    const hash = (await h.read!({ vault: "main", path: "a.md" })).hash;
    const calls: [string, any][] = [
      ["write", { vault: "main", path: "a.md", content: "x", expectedHash: hash }],
      ["create", { vault: "main", path: "n.md", type: "file" }],
      ["rename", { vault: "main", from: "a.md", to: "b.md" }],
      ["trash", { vault: "main", path: "a.md", confirm: true }],
      ["trash_restore", { vault: "main", id: "x", path: "a.md" }],
      ["upload_image", { vault: "main", note: "a.md", name: "x.png", base64: "AAAA" }],
    ];
    for (const [name, input] of calls) {
      await expect(h[name]!(input), name).rejects.toThrow(/Somente leitura/);
    }
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# A\n");
    expect(existsSync(join(root, "n.md"))).toBe(false);
    expect(existsSync(join(root, ".lixeira"))).toBe(false);
    // leitura continua funcionando
    expect((await h.vaults!(null)).readOnly).toBe(true);
    expect((await h.tree!({ vault: "main" })).entries.length).toBeGreaterThan(0);
  });

  it("sem somente leitura grava normalmente (controle)", async () => {
    const root = makeRoot();
    const h = await boot(root, false);
    const hash = (await h.read!({ vault: "main", path: "a.md" })).hash;
    expect((await h.write!({ vault: "main", path: "a.md", content: "novo\n", expectedHash: hash })).status).toBe("ok");
  });
});

describe("cofres", () => {
  it("sem raiz configurada não há cofre (nunca assume ~/Notes)", () => {
    expect(parseVaults("", "")).toEqual([]);
  });
  it("lê Nome=/caminho e ~/", () => {
    const v = parseVaults("/tmp/x", "Orion=/tmp/t\n# comentário\n/tmp/solto");
    expect(v.map((x) => x.name)).toEqual(["x", "Orion", "solto"]);
  });
});

describe("erros sem caminhos internos", () => {
  it("erro de sistema de arquivos não revela o caminho absoluto", async () => {
    const root = makeRoot();
    const h = await boot(root, false);
    let message = "";
    try {
      await h.create!({ vault: "main", path: "a.md/filho.md", type: "file" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(root);
    expect(message).not.toContain("/tmp");
  });
});

describe("somente leitura ao vivo", () => {
  it("mudar a configuração vale sem recarregar o plugin (nos dois sentidos)", async () => {
    const root = makeRoot();
    const listeners: Array<(n: any) => void> = [];
    const h = await boot(root, true, listeners);
    const hash = (await h.read!({ vault: "main", path: "a.md" })).hash;
    await expect(h.write!({ vault: "main", path: "a.md", content: "x\n", expectedHash: hash })).rejects.toThrow(/Somente leitura/);
    listeners.forEach((l) => l({ readOnly: false }));
    expect((await h.vaults!(null)).readOnly).toBe(false);
    expect((await h.write!({ vault: "main", path: "a.md", content: "x\n", expectedHash: hash })).status).toBe("ok");
    listeners.forEach((l) => l({ readOnly: true }));
    expect((await h.vaults!(null)).readOnly).toBe(true);
    await expect(h.create!({ vault: "main", path: "n.md", type: "file" })).rejects.toThrow(/Somente leitura/);
  });
});

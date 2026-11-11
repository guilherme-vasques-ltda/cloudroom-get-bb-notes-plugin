// Notes — backend do plugin. Roda no servidor do Cloudroom (no Mac do dono) e lê/grava
// direto no disco, SEMPRE dentro da pasta raiz configurada (lib/notes-fs.ts).
// Sem rede, sem telemetria, sem segredos.
//
// Baseado em ideias do plugin "Docs" do get-bb/bb (MIT, © 2026 Michael Yong):
// cofres, conflito por hash (compare-and-swap) e atualização ao vivo. Ver LICENSE/NOTICE.
import { watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve as resolvePath } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { NotesError, NotesStore, buildSandboxedHtml } from "./lib/notes-fs";

const vaultArg = z.string().min(1).max(40);
const pathArg = z.string().max(1024);

const entrySchema = z.object({
  path: z.string(),
  name: z.string(),
  type: z.enum(["dir", "file"]),
  kind: z.enum(["markdown", "html", "image", "text", "other"]).nullable(),
  size: z.number(),
  mtimeMs: z.number(),
});

const writeResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), hash: z.string(), mtimeMs: z.number(), size: z.number() }),
  z.object({
    status: z.literal("conflict"),
    currentContent: z.string().nullable(),
    currentHash: z.string(),
    mtimeMs: z.number(),
  }),
  z.object({ status: z.literal("missing") }),
]);

export const rpcContract = defineRpcContract({
  vaults: {
    input: z.null(),
    output: z.object({
      readOnly: z.boolean(),
      vaults: z.array(
        z.object({ id: z.string(), name: z.string(), root: z.string(), error: z.string().nullable() }),
      ),
    }),
  },
  tree: {
    input: z.object({ vault: vaultArg }),
    output: z.object({ entries: z.array(entrySchema), truncated: z.boolean() }),
  },
  read: {
    input: z.object({ vault: vaultArg, path: pathArg }),
    output: z.object({
      kind: z.enum(["markdown", "html", "image", "text", "other"]),
      content: z.string().nullable(),
      hash: z.string(),
      size: z.number(),
      mtimeMs: z.number(),
      reason: z.enum(["binary", "too_large", "unsupported"]).nullable(),
    }),
  },
  asset: {
    input: z.object({ vault: vaultArg, path: pathArg }),
    output: z.object({ dataUrl: z.string(), mime: z.string(), size: z.number() }),
  },
  html: {
    input: z.object({ vault: vaultArg, path: pathArg, content: z.string().max(6_000_000) }),
    output: z.object({ html: z.string() }),
  },
  write: {
    input: z.object({
      vault: vaultArg,
      path: pathArg,
      content: z.string().max(6_000_000),
      expectedHash: z.string(),
      /** "Manter o meu": expectedHash é o hash da versão deles, que vai para a lixeira. */
      keepMine: z.boolean().optional(),
      /** Guarda a versão anterior em .lixeira/versoes (1ª gravação de cada edição). */
      snapshot: z.boolean().optional(),
    }),
    output: writeResultSchema,
  },
  upload_image: {
    input: z.object({ vault: vaultArg, note: pathArg, name: z.string().max(200), base64: z.string().max(40_000_000) }),
    output: z.object({ path: z.string() }),
  },
  conflict_copy: {
    input: z.object({ vault: vaultArg, path: pathArg, content: z.string().max(6_000_000) }),
    output: z.object({ id: z.string() }),
  },
  create: {
    input: z.object({ vault: vaultArg, path: pathArg, type: z.enum(["file", "dir"]), content: z.string().max(1_000_000).optional() }),
    output: z.object({ path: z.string() }),
  },
  rename: {
    input: z.object({ vault: vaultArg, from: pathArg, to: pathArg }),
    output: z.object({ path: z.string() }),
  },
  // `confirm` só aceita o literal true: sem confirmação explícita a chamada nem passa
  // pela validação. Mesmo confirmada, vira MOVER para .lixeira (nunca apaga).
  trash: {
    input: z.object({ vault: vaultArg, path: pathArg, confirm: z.literal(true) }),
    output: z.object({ trashId: z.string(), path: z.string() }),
  },
  trash_list: {
    input: z.object({ vault: vaultArg }),
    output: z.object({ items: z.array(z.object({ id: z.string(), path: z.string(), type: z.enum(["dir", "file"]) })) }),
  },
  trash_restore: {
    input: z.object({ vault: vaultArg, id: z.string().max(100), path: pathArg }),
    output: z.object({ path: z.string() }),
  },
  search: {
    input: z.object({ vault: vaultArg, query: z.string().max(200), content: z.boolean() }),
    output: z.object({
      hits: z.array(
        z.object({
          path: z.string(),
          name: z.string(),
          type: z.enum(["dir", "file"]),
          matchedName: z.boolean(),
          snippets: z.array(z.object({ line: z.number(), text: z.string() })),
        }),
      ),
    }),
  },
});

/** Canal em tempo real: o app refaz a árvore / confere o arquivo aberto. */
const CHANGED = "notes-changed";

type VaultDef = { id: string; name: string; root: string };

function expandHome(p: string): string {
  const t = p.trim();
  if (t === "~") return homedir();
  if (t.startsWith("~/")) return resolvePath(homedir(), t.slice(2));
  return t;
}

export function parseVaults(root: string, extra: string): VaultDef[] {
  const out: VaultDef[] = [];
  if (root.trim() !== "") {
    const abs = expandHome(root);
    out.push({ id: "main", name: basename(abs) || "Notes", root: abs });
  }
  let n = 2;
  for (const raw of extra.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const name = eq > 0 ? line.slice(0, eq).trim() : "";
    const path = expandHome(eq > 0 ? line.slice(eq + 1) : line);
    out.push({ id: `v${n++}`, name: name || basename(path) || "Cofre", root: path });
  }
  return out;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    root: {
      type: "string",
      label: "Pasta raiz das notas",
      description:
        "Pasta no disco com suas notas (ex.: /caminho/para/Notes). O plugin só lê e grava DENTRO dela. Recarregue o plugin depois de mudar.",
      default: "",
    },
    extraVaults: {
      type: "string",
      label: "Outras pastas (cofres)",
      description: "Uma por linha, no formato Nome=/caminho/da/pasta.",
      experimental_multiline: true,
      default: "",
    },
    readOnly: {
      type: "boolean",
      label: "Somente leitura",
      description: "Bloqueia qualquer gravação, criação, renomeação, remoção ou upload (útil na primeira instalação).",
      default: false,
    },
  });
  const cfg = await settings.get();
  const vaults = parseVaults(cfg.root, cfg.extraVaults);
  // "Somente leitura" vale ao vivo: mudar a configuração não exige recarregar o plugin.
  let readOnly = cfg.readOnly === true;
  settings.onChange?.((next) => {
    readOnly = next.readOnly === true;
    bb.log.info(`readOnly agora: ${readOnly}`);
  });
  const writable = () => {
    if (readOnly) throw new NotesError("read_only", "Somente leitura: o plugin está configurado para não gravar nada.");
  };
  const stores = new Map<string, { store: NotesStore | null; error: string | null }>();
  for (const v of vaults) {
    try {
      stores.set(v.id, { store: new NotesStore(v.root), error: null });
    } catch (cause) {
      stores.set(v.id, { store: null, error: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  bb.log.info(`vaults: ${vaults.map((v) => `${v.id}=${v.root}`).join(", ") || "(nenhum configurado)"}`);

  function storeFor(vault: string): NotesStore {
    const entry = stores.get(vault);
    if (entry === undefined) throw new Error("Cofre desconhecido. Configure a pasta raiz em Ajustes do plugin.");
    if (entry.store === null) throw new Error(entry.error ?? "Cofre indisponível.");
    return entry.store;
  }
  const guard = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (cause) {
      if (cause instanceof NotesError) throw new Error(cause.message);
      // erros do sistema de arquivos trazem caminhos absolutos: só vão para o log do plugin
      bb.log.warn(`erro de arquivo: ${cause instanceof Error ? cause.message : String(cause)}`);
      throw new Error("Não consegui acessar o arquivo (detalhes no log do plugin).");
    }
  };
  const changed = (vault: string, paths: string[]) => bb.realtime.publish(CHANGED, { vault, paths: paths.slice(0, 50) });

  bb.rpc.register(rpcContract, {
    vaults: async () => ({
      readOnly,
      vaults: vaults.map((v) => ({ id: v.id, name: v.name, root: v.root, error: stores.get(v.id)?.error ?? null })),
    }),
    tree: async ({ vault }) => guard(() => storeFor(vault).tree()),
    read: async ({ vault, path }) =>
      guard(() => {
        const r = storeFor(vault).read(path);
        return { ...r, reason: r.reason ?? null };
      }),
    asset: async ({ vault, path }) => guard(() => storeFor(vault).readAsset(path)),
    html: async ({ vault, path, content }) => guard(() => ({ html: buildSandboxedHtml(storeFor(vault), path, content) })),
    upload_image: async ({ vault, note, name, base64 }) =>
      guard(() => {
        writable();
        const res = storeFor(vault).saveImage(note, name, Buffer.from(base64, "base64"));
        bb.log.info(`upload_image ${note} -> ${res.path}`);
        changed(vault, []);
        return res;
      }),
    conflict_copy: async ({ vault, path, content }) =>
      guard(() => {
        writable();
        return storeFor(vault).saveConflictCopy(path, content);
      }),
    write: async ({ vault, path, content, expectedHash, keepMine, snapshot }) =>
      guard(() => {
        writable();
        const s = storeFor(vault);
        const res = keepMine === true ? s.writeKeepMine(path, content, expectedHash) : s.write(path, content, expectedHash, { snapshot });
        if (res.status === "ok") {
          changed(vault, [path]);
          if (snapshot === true || keepMine === true) bb.log.info(`write ${path}${keepMine === true ? " (manter o meu)" : ""}`);
        } else bb.log.info(`write ${path}: ${res.status}`);
        return res;
      }),
    create: async ({ vault, path, type, content }) =>
      guard(() => {
        writable();
        const res = storeFor(vault).create(path, type, content ?? "");
        bb.log.info(`create ${type} ${res.path}`);
        changed(vault, [res.path]);
        return res;
      }),
    rename: async ({ vault, from, to }) =>
      guard(() => {
        writable();
        const res = storeFor(vault).rename(from, to);
        bb.log.info(`rename ${from} -> ${res.path}`);
        changed(vault, [from, res.path]);
        return res;
      }),
    trash: async ({ vault, path, confirm }) =>
      guard(() => {
        writable();
        const res = storeFor(vault).trash(path, confirm);
        bb.log.info(`trash ${path} -> .lixeira/${res.trashId}`);
        changed(vault, [path]);
        return res;
      }),
    trash_list: async ({ vault }) => guard(() => ({ items: storeFor(vault).listTrash() })),
    trash_restore: async ({ vault, id, path }) =>
      guard(() => {
        writable();
        const res = storeFor(vault).restore(id, path);
        bb.log.info(`restore ${id} -> ${res.path}`);
        changed(vault, [res.path]);
        return res;
      }),
    search: async ({ vault, query, content }) => guard(() => ({ hits: storeFor(vault).search(query, content) })),
  });

  // Atualização ao vivo: vigia cada cofre e avisa o app (debounce de 250 ms).
  bb.background.service("watcher", {
    async start(signal) {
      const watchers: FSWatcher[] = [];
      const timers: NodeJS.Timeout[] = [];
      for (const v of vaults) {
        const entry = stores.get(v.id);
        if (entry?.store == null) continue;
        let pending = new Set<string>();
        let timer: NodeJS.Timeout | null = null;
        try {
          const w = watch(entry.store.root, { recursive: true, signal }, (_event, filename) => {
            const name = filename === null ? "" : String(filename);
            // temporários (.x.tmp-…) e ocultos (.lixeira) não interessam
            if (name.split("/").some((seg) => seg.startsWith("."))) return;
            pending.add(name);
            if (timer !== null) return;
            timer = setTimeout(() => {
              timer = null;
              const paths = [...pending];
              pending = new Set();
              changed(v.id, paths);
            }, 250);
            timers.push(timer);
          });
          w.on("error", (e) => bb.log.warn(`watcher ${v.id}: ${e.message}`));
          watchers.push(w);
        } catch (cause) {
          bb.log.warn(`watcher ${v.id} indisponível: ${(cause as Error).message}`);
        }
      }
      await new Promise<void>((done) => {
        if (signal.aborted) done();
        signal.addEventListener("abort", () => done(), { once: true });
      });
      for (const w of watchers) w.close();
      for (const t of timers) clearTimeout(t);
    },
  });

  // Comando para agentes: `room-cli notes list|read|write` (escrita só com checagem de versão).
  bb.cli.register({
    name: "notes",
    summary: "Ler e escrever notas (Markdown) da pasta Notes, com checagem de versão",
    commands: [
      { name: "vaults", summary: "Lista os cofres configurados", usage: "room-cli notes vaults" },
      { name: "list", summary: "Lista arquivos (pasta opcional)", usage: "room-cli notes list [pasta] [--vault id] [--json]" },
      { name: "read", summary: "Lê uma nota e mostra o hash da versão", usage: "room-cli notes read <caminho> [--vault id] [--json]" },
      {
        name: "write",
        summary: "Grava uma nota; --expect-hash é obrigatório (use o hash do read) e conflito aborta",
        usage: "room-cli notes write <caminho> --expect-hash <hash> --content <texto> [--vault id]",
      },
    ],
    async run(argv) {
      const take = (flag: string): string | undefined => {
        const i = argv.indexOf(flag);
        if (i < 0) return undefined;
        return argv[i + 1];
      };
      const json = argv.includes("--json");
      const vault = take("--vault") ?? vaults[0]?.id ?? "main";
      const positional: string[] = [];
      for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a === "--json") continue;
        if (a.startsWith("--")) {
          i++;
          continue;
        }
        positional.push(a);
      }
      const [cmd, target] = positional;
      const fail = (m: string) => ({ exitCode: 1, stderr: m });
      try {
        switch (cmd) {
          case "vaults":
            return { exitCode: 0, stdout: JSON.stringify(vaults, null, json ? 0 : 2) };
          case "list": {
            const prefix = (target ?? "").replace(/^\/+|\/+$/g, "");
            const entries = storeFor(vault)
              .tree()
              .entries.filter((e) => prefix === "" || e.path === prefix || e.path.startsWith(`${prefix}/`));
            return { exitCode: 0, stdout: json ? JSON.stringify(entries) : entries.map((e) => `${e.type === "dir" ? "d" : "-"} ${e.path}`).join("\n") };
          }
          case "read": {
            if (target === undefined) return fail("Informe o caminho.");
            const r = storeFor(vault).read(target);
            if (r.content === null) return fail(`Não é texto editável (${r.reason ?? r.kind}).`);
            return { exitCode: 0, stdout: json ? JSON.stringify({ path: target, hash: r.hash, content: r.content }) : `hash: ${r.hash}\n---\n${r.content}` };
          }
          case "write": {
            const expect = take("--expect-hash");
            const content = take("--content");
            if (target === undefined || expect === undefined || content === undefined) {
              return fail("Uso: room-cli notes write <caminho> --expect-hash <hash> --content <texto>");
            }
            writable();
            const res = storeFor(vault).write(target, content, expect, { snapshot: true });
            if (res.status === "ok") {
              changed(vault, [target]);
              return { exitCode: 0, stdout: json ? JSON.stringify(res) : `ok hash=${res.hash}` };
            }
            return {
              exitCode: 2,
              stderr: res.status === "conflict" ? `CONFLITO: o arquivo mudou (hash atual ${res.currentHash}). Leia de novo e refaça.` : "Arquivo não existe mais.",
            };
          }
          default:
            return fail("Uso: room-cli notes vaults | list [pasta] | read <caminho> | write <caminho> --expect-hash <h> --content <t>");
        }
      } catch (cause) {
        return fail(cause instanceof Error ? cause.message : String(cause));
      }
    },
  });
}

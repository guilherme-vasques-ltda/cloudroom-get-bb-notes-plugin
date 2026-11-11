// Núcleo de arquivos do plugin Notes. Só Node (node:fs/path/crypto): nada de rede,
// nada de telemetria, nada de segredos. Toda operação passa por `resolve`, que
// prende o caminho dentro da raiz (sem `..`, sem absoluto, sem symlink que saia).
//
// Regras de segurança:
//  - caminhos são SEMPRE relativos à raiz, com "/" como separador;
//  - segmentos que começam com "." são inacessíveis (.git, .env, .lixeira, tmp);
//  - nunca existe "apagar de verdade": remover = mover para <raiz>/.lixeira/<data>/...
//    e só com confirm === true;
//  - gravação compara o hash do que foi lido com o que está no disco (conflito);
//  - gravação é atômica (arquivo temporário + rename).
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";

export const TRASH_DIR = ".lixeira";
export const BACKUP_BUCKETS = ["conflitos", "versoes"] as const;
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_TREE_ENTRIES = 50_000;

export type NotesErrorCode =
  | "bad_path"
  | "outside_root"
  | "not_found"
  | "exists"
  | "not_confirmed"
  | "not_text"
  | "too_large"
  | "root_missing"
  | "invalid_move"
  | "read_only"
  | "io";

export class NotesError extends Error {
  readonly code: NotesErrorCode;
  constructor(code: NotesErrorCode, message: string) {
    super(message);
    this.name = "NotesError";
    this.code = code;
  }
}

export type FileKind = "markdown" | "html" | "image" | "text" | "other";

const MARKDOWN_EXT = new Set([".md", ".mdx", ".markdown"]);
const HTML_EXT = new Set([".html", ".htm"]);
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
};
const TEXT_EXT = new Set([
  ".txt", ".json", ".yaml", ".yml", ".toml", ".csv", ".log", ".css", ".js",
  ".ts", ".tsx", ".jsx", ".sh", ".xml", ".ini", ".env.example", ".rs", ".py",
]);

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i).toLowerCase();
}

export function kindOf(name: string): FileKind {
  const ext = extOf(name);
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (HTML_EXT.has(ext)) return "html";
  if (ext in IMAGE_MIME) return "image";
  if (TEXT_EXT.has(ext)) return "text";
  return "other";
}

export function imageMime(name: string): string | null {
  return IMAGE_MIME[extOf(name)] ?? null;
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export type TreeEntry = {
  path: string;
  name: string;
  type: "dir" | "file";
  kind: FileKind | null;
  size: number;
  mtimeMs: number;
};

export type ReadResult = {
  kind: FileKind;
  /** null quando o arquivo não é texto editável. */
  content: string | null;
  hash: string;
  size: number;
  mtimeMs: number;
  reason?: "binary" | "too_large" | "unsupported";
};

export type WriteResult =
  | { status: "ok"; hash: string; mtimeMs: number; size: number }
  | {
      status: "conflict";
      /** Conteúdo atual no disco (a versão "deles"). */
      currentContent: string | null;
      currentHash: string;
      mtimeMs: number;
    }
  | { status: "missing" };

export type SearchHit = {
  path: string;
  name: string;
  type: "dir" | "file";
  matchedName: boolean;
  snippets: { line: number; text: string }[];
};

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function stamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export class NotesStore {
  /** Raiz já resolvida (realpath). */
  readonly root: string;

  constructor(rootInput: string) {
    if (typeof rootInput !== "string" || rootInput.trim() === "") {
      throw new NotesError("root_missing", "Pasta raiz não configurada.");
    }
    let real: string;
    try {
      real = realpathSync(rootInput);
    } catch {
      throw new NotesError("root_missing", `A pasta raiz não existe: ${rootInput}`);
    }
    if (!statSync(real).isDirectory()) {
      throw new NotesError("root_missing", `A raiz não é uma pasta: ${rootInput}`);
    }
    this.root = real;
  }

  /**
   * Traduz um caminho relativo (vindo do navegador) em caminho absoluto SEGURO.
   * Lança NotesError("bad_path" | "outside_root") em qualquer tentativa de fuga.
   */
  resolve(rel: string, opts: { allowRoot?: boolean } = {}): string {
    if (typeof rel !== "string") throw new NotesError("bad_path", "Caminho inválido.");
    if (rel.includes("\0") || rel.includes("\\")) {
      throw new NotesError("bad_path", "Caminho inválido.");
    }
    if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) {
      throw new NotesError("bad_path", "Caminho absoluto não é permitido.");
    }
    const segments = rel.split("/").filter((s) => s !== "" && s !== ".");
    for (const seg of segments) {
      if (seg === "..") throw new NotesError("bad_path", "'..' não é permitido.");
      if (seg.startsWith(".")) {
        throw new NotesError("bad_path", "Arquivos e pastas ocultos não são acessíveis.");
      }
    }
    if (segments.length === 0) {
      if (opts.allowRoot) return this.root;
      throw new NotesError("bad_path", "Caminho vazio.");
    }
    const abs = join(this.root, ...segments);
    // O maior prefixo que já existe precisa resolver para dentro da raiz
    // (pega symlink apontando para fora, inclusive em pastas intermediárias).
    let probe = abs;
    let tail = "";
    for (;;) {
      try {
        lstatSync(probe);
        break;
      } catch {
        const parent = dirname(probe);
        if (parent === probe) throw new NotesError("outside_root", "Caminho fora da raiz.");
        tail = join(basename(probe), tail);
        probe = parent;
      }
    }
    let realProbe: string;
    try {
      realProbe = realpathSync(probe);
    } catch {
      // symlink quebrado: não seguimos
      throw new NotesError("outside_root", "Link simbólico inválido.");
    }
    const finalPath = tail === "" ? realProbe : join(realProbe, tail);
    if (!isInside(this.root, finalPath)) {
      throw new NotesError("outside_root", "Caminho fora da raiz.");
    }
    // A política de ocultos vale também para o destino real (um link não pode expor ".env" etc.).
    if (this.relOf(finalPath).split("/").some((seg) => seg.startsWith("."))) {
      throw new NotesError("bad_path", "Arquivos e pastas ocultos não são acessíveis.");
    }
    return finalPath;
  }

  /** Caminho "como digitado" (sem seguir links): usado só para recusar mexer no próprio link. */
  private lexical(rel: string): string {
    return join(this.root, ...rel.split("/").filter((x) => x !== "" && x !== "."));
  }

  private refuseLink(rel: string): void {
    try {
      if (lstatSync(this.lexical(rel)).isSymbolicLink()) {
        throw new NotesError("invalid_move", "Links simbólicos não são movidos nem removidos por aqui.");
      }
    } catch (e) {
      if (e instanceof NotesError) throw e;
    }
  }

  /** mkdir -p nível a nível: recusa links simbólicos e confere que o resultado continua dentro da raiz. */
  private safeMkdirp(absDir: string): void {
    if (!isInside(this.root, absDir)) throw new NotesError("outside_root", "Caminho fora da raiz.");
    let cur = this.root;
    for (const part of absDir.slice(this.root.length + 1).split(sep).filter(Boolean)) {
      cur = join(cur, part);
      let st;
      try {
        st = lstatSync(cur);
      } catch {
        mkdirSync(cur);
        st = lstatSync(cur);
      }
      if (st.isSymbolicLink()) throw new NotesError("outside_root", "Link simbólico no caminho.");
      if (!st.isDirectory()) throw new NotesError("exists", "Existe um arquivo no lugar de uma pasta.");
    }
    if (realpathSync(absDir) !== absDir) throw new NotesError("outside_root", "Caminho mudou durante a operação.");
  }

  /** Confere (sem seguir links) que cada nível de `abs` abaixo da raiz é pasta/arquivo comum. */
  private assertPlainChain(abs: string): void {
    if (!isInside(this.root, abs)) throw new NotesError("outside_root", "Caminho fora da raiz.");
    let cur = this.root;
    for (const part of abs.slice(this.root.length + 1).split(sep).filter(Boolean)) {
      cur = join(cur, part);
      let st;
      try {
        st = lstatSync(cur);
      } catch {
        throw new NotesError("not_found", "Item não encontrado.");
      }
      if (st.isSymbolicLink()) throw new NotesError("outside_root", "Link simbólico na lixeira.");
    }
  }

  /**
   * Move sem sobrescrever destino existente.
   * - Arquivo: link() exclusivo (falha se o destino existir). O nome antigo só é largado se continuar sendo
   *   o MESMO arquivo (mesmo inode) de antes do link: se um editor publicou uma versão nova em `from`
   *   nesse meio-tempo, ela é mantida e nada se perde. Se não der para largar o nome antigo, desfaz.
   * - Pasta: cria o destino de forma exclusiva e só então renomeia por cima dele (vazio, criado por nós).
   */
  private moveNoClobber(from: string, to: string): void {
    try {
      const before = lstatSync(from);
      if (before.isDirectory()) {
        mkdirSync(to); // exclusivo: EEXIST se já existe
        try {
          renameSync(from, to);
        } catch (e) {
          try {
            rmdirSync(to); // só remove a pasta VAZIA que acabamos de criar
          } catch {
            /* ignorado */
          }
          throw e;
        }
        return;
      }
      linkSync(from, to); // exclusivo
      let after;
      try {
        after = lstatSync(from);
      } catch {
        return; // origem já não existe: o conteúdo está em `to`
      }
      if (after.ino !== before.ino || after.dev !== before.dev) return; // nova versão em `from`: mantém as duas
      try {
        unlinkSync(from);
      } catch {
        this.dropScratch(to); // desfaz: `to` era só o nosso novo nome para o mesmo arquivo
        throw new NotesError("io", "Não consegui concluir a movimentação.");
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR") {
        throw new NotesError("exists", "Já existe um item com esse nome no destino.");
      }
      if (e instanceof NotesError) throw e;
      throw new NotesError("io", "Falha ao mover o item.");
    }
  }

  /** Remove um nome que acabou de ser duplicado em outro lugar ou um arquivo temporário NOSSO. */
  private dropScratch(path: string): void {
    try {
      unlinkSync(path);
    } catch {
      /* já não existe */
    }
  }

  relOf(abs: string): string {
    return abs === this.root ? "" : abs.slice(this.root.length + 1).split(sep).join("/");
  }

  /** Lista plana de tudo sob a raiz (ocultos e symlinks que escapam ficam de fora). */
  tree(): { entries: TreeEntry[]; truncated: boolean } {
    const entries: TreeEntry[] = [];
    let truncated = false;
    const walk = (absDir: string, relDir: string, depth: number) => {
      if (depth > 40) return;
      let names: string[];
      try {
        names = readdirSync(absDir);
      } catch {
        return;
      }
      for (const name of names) {
        if (name.startsWith(".")) continue;
        if (entries.length >= MAX_TREE_ENTRIES) {
          truncated = true;
          return;
        }
        const abs = join(absDir, name);
        const rel = relDir === "" ? name : `${relDir}/${name}`;
        let real: string;
        let st;
        try {
          real = realpathSync(abs);
          if (!isInside(this.root, real)) continue; // symlink para fora: invisível
          st = statSync(abs);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          entries.push({ path: rel, name, type: "dir", kind: null, size: 0, mtimeMs: st.mtimeMs });
          // não entra em symlink de pasta que aponta para outro lugar da raiz (evita ciclos)
          if (!lstatSync(abs).isSymbolicLink()) walk(abs, rel, depth + 1);
        } else if (st.isFile()) {
          entries.push({
            path: rel,
            name,
            type: "file",
            kind: kindOf(name),
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
        }
      }
    };
    walk(this.root, "", 0);
    return { entries, truncated };
  }

  read(rel: string): ReadResult {
    const abs = this.resolve(rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      throw new NotesError("not_found", "Arquivo não encontrado.");
    }
    if (!st.isFile()) throw new NotesError("not_found", "Não é um arquivo.");
    const name = basename(abs);
    const kind = kindOf(name);
    if (kind === "image" || kind === "other") {
      return { kind, content: null, hash: "", size: st.size, mtimeMs: st.mtimeMs, reason: kind === "image" ? undefined : "unsupported" };
    }
    if (st.size > MAX_TEXT_BYTES) {
      return { kind, content: null, hash: "", size: st.size, mtimeMs: st.mtimeMs, reason: "too_large" };
    }
    const buf = readFileSync(abs);
    if (this.resolve(rel) !== abs) throw new NotesError("outside_root", "Caminho mudou durante a leitura.");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
    } catch {
      // não é UTF-8 válido: editar poderia corromper
      return { kind, content: null, hash: sha256(buf), size: st.size, mtimeMs: st.mtimeMs, reason: "binary" };
    }
    return { kind, content, hash: sha256(buf), size: st.size, mtimeMs: st.mtimeMs };
  }

  /** Lê um arquivo como bytes (imagens/anexos). */
  readAsset(rel: string): { dataUrl: string; mime: string; size: number } {
    const abs = this.resolve(rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      throw new NotesError("not_found", "Arquivo não encontrado.");
    }
    if (!st.isFile()) throw new NotesError("not_found", "Não é um arquivo.");
    const mime = imageMime(basename(abs));
    if (mime === null) throw new NotesError("not_text", "Só imagens podem ser lidas como anexo.");
    if (st.size > MAX_ASSET_BYTES) throw new NotesError("too_large", "Imagem grande demais.");
    const buf = readFileSync(abs);
    if (this.resolve(rel) !== abs) throw new NotesError("outside_root", "Caminho mudou durante a leitura.");
    return { dataUrl: `data:${mime};base64,${buf.toString("base64")}`, mime, size: st.size };
  }

  /** Tamanho e tipo (sem checar permissão do arquivo): usado também ao guardar texto descartado. */
  private validateContent(abs: string, content: string): void {
    if (Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES) {
      throw new NotesError("too_large", "Conteúdo grande demais.");
    }
    const k = kindOf(basename(abs));
    if (k === "image" || k === "other") throw new NotesError("not_text", "Este tipo de arquivo não é editável.");
  }

  private validateWrite(abs: string, content: string): void {
    if (Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES) {
      throw new NotesError("too_large", "Conteúdo grande demais.");
    }
    const k = kindOf(basename(abs));
    if (k === "image" || k === "other") throw new NotesError("not_text", "Este tipo de arquivo não é editável.");
    try {
      if ((statSync(abs).mode & 0o200) === 0) throw new NotesError("read_only", "Este arquivo está protegido contra escrita (somente leitura no sistema).");
    } catch (e) {
      if (e instanceof NotesError) throw e;
    }
  }

  private decode(buf: Buffer): string | null {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
    } catch {
      return null;
    }
  }

  /**
   * Grava com detecção de conflito.
   * - expectedHash = hash do conteúdo que o editor leu por último;
   * - se o disco mudou desde então → { status: "conflict" } e NADA é gravado;
   * - o hash é conferido de novo imediatamente antes do rename (a janela que sobra é de microssegundos,
   *   a mesma de qualquer editor que salva por troca atômica; nenhum plugin consegue fechá-la sem
   *   bloqueio do sistema operacional).
   * O arquivo original NUNCA é movido: a cópia de segurança é um arquivo independente.
   */
  write(rel: string, content: string, expectedHash: string, opts: { snapshot?: boolean } = {}): WriteResult {
    const abs = this.resolve(rel);
    this.validateWrite(abs, content);
    if (!existsSync(abs)) return { status: "missing" };
    const current = readFileSync(abs);
    const currentHash = sha256(current);
    if (currentHash !== expectedHash) {
      return { status: "conflict", currentContent: this.decode(current), currentHash, mtimeMs: statSync(abs).mtimeMs };
    }
    // 1ª gravação de uma sessão de edição: guarda a versão anterior (desfazer de emergência),
    // mas só no instante do commit, depois da reconferência (sem cópias em tentativas que falham).
    const keep = opts.snapshot === true && content !== current.toString("utf8") ? ("versoes" as const) : null;
    return this.commitIfUnchanged(abs, content, expectedHash, keep);
  }

  /** "Manter o meu": guarda a versão deles em .lixeira/conflitos e sobrescreve com a minha. */
  writeKeepMine(rel: string, content: string, theirHash: string): WriteResult {
    const abs = this.resolve(rel);
    this.validateWrite(abs, content);
    if (!existsSync(abs)) return { status: "missing" };
    const current = readFileSync(abs);
    if (sha256(current) !== theirHash) {
      // mudou DE NOVO enquanto o usuário decidia: volta a ser conflito
      return this.write(rel, content, theirHash);
    }
    return this.commitIfUnchanged(abs, content, theirHash, "conflitos");
  }

  /** Escreve o novo conteúdo num temporário, reconfere o hash e troca por rename atômico. */
  private commitIfUnchanged(abs: string, content: string, expectedHash: string, keep: "versoes" | "conflitos" | null = null): WriteResult {
    const tmp = join(dirname(abs), `.${basename(abs)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
    let mode: number | undefined;
    try {
      mode = statSync(abs).mode & 0o777;
    } catch {
      return { status: "missing" };
    }
    try {
      writeFileSync(tmp, content, { encoding: "utf8", flag: "wx" });
      if (mode !== undefined) chmodSync(tmp, mode);
      const fd = openSync(tmp, "r+");
      try {
        fsyncSync(fd); // o novo conteúdo está no disco antes do rename (queda de energia não deixa arquivo vazio)
      } finally {
        closeSync(fd);
      }
      let now: Buffer;
      try {
        now = readFileSync(abs);
      } catch {
        this.dropScratch(tmp);
        return { status: "missing" };
      }
      if (sha256(now) !== expectedHash) {
        this.dropScratch(tmp);
        return { status: "conflict", currentContent: this.decode(now), currentHash: sha256(now), mtimeMs: statSync(abs).mtimeMs };
      }
      if (keep !== null) {
        this.backupCopy(abs, now, keep); // bytes que acabamos de verificar
        // a cópia leva alguns milissegundos: reconfere o hash de novo, logo antes do rename
        const again = readFileSync(abs);
        if (sha256(again) !== expectedHash) {
          this.dropScratch(tmp);
          return { status: "conflict", currentContent: this.decode(again), currentHash: sha256(again), mtimeMs: statSync(abs).mtimeMs };
        }
      }
      renameSync(tmp, abs);
    } catch (cause) {
      this.dropScratch(tmp); // só o NOSSO arquivo temporário
      if (cause instanceof NotesError) throw cause;
      throw new NotesError("io", `Falha ao gravar (${(cause as NodeJS.ErrnoException).code ?? "erro"}).`);
    }
    const st = statSync(abs);
    return { status: "ok", hash: sha256(Buffer.from(content, "utf8")), mtimeMs: st.mtimeMs, size: st.size };
  }

  /** Guarda o TEXTO do usuário (que vai ser descartado em "Pegar o deles") em .lixeira/conflitos. */
  saveConflictCopy(rel: string, content: string): { id: string } {
    const abs = this.resolve(rel);
    this.validateContent(abs, content);
    const before = new Set(this.listTrash().map((t) => `${t.id}`));
    this.backupCopy(abs, Buffer.from(content, "utf8"), "conflitos");
    const added = this.listTrash().find((t) => t.id.startsWith("conflitos/") && !before.has(t.id));
    return { id: added?.id ?? "conflitos" };
  }

  /** Cópia de segurança INDEPENDENTE (bytes já verificados) em .lixeira/<bucket>/<id>/<caminho>. */
  private backupCopy(abs: string, bytes: Buffer, bucket: "versoes" | "conflitos"): void {
    this.assertTrashBase();
    const id = `${stamp()}-${randomBytes(2).toString("hex")}`;
    const bucketDir = join(this.root, TRASH_DIR, bucket, id);
    const dest = join(bucketDir, this.relOf(abs));
    this.safeMkdirp(dirname(dest));
    writeFileSync(dest, bytes, { flag: "wx" });
    try {
      chmodSync(dest, statSync(abs).mode & 0o777); // a cópia tem a mesma permissão da nota (ex.: 0600)
    } catch {
      /* ignorado */
    }
    this.writeManifest(bucketDir, abs);
  }

  private writeManifest(bucketDir: string, abs: string): void {
    try {
      writeFileSync(join(bucketDir, ".item.json"), JSON.stringify({ path: this.relOf(abs) }), { flag: "wx" });
    } catch {
      /* manifesto é só conveniência */
    }
  }

  private assertTrashBase(): void {
    const base = join(this.root, TRASH_DIR);
    try {
      const st = lstatSync(base);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new NotesError("outside_root", "A lixeira não é uma pasta comum; recusado.");
      }
    } catch (e) {
      if (e instanceof NotesError) throw e;
      /* ainda não existe: será criada por safeMkdirp */
    }
  }

  /** Salva uma imagem colada/arrastada em <pasta da nota>/_attachments/. Nunca sobrescreve. */
  saveImage(noteRel: string, filename: string, data: Buffer): { path: string } {
    const note = this.resolve(noteRel);
    const ext = extOf(filename);
    if (!(ext in IMAGE_MIME)) throw new NotesError("not_text", "Só imagens são aceitas.");
    if (data.length > MAX_ASSET_BYTES) throw new NotesError("too_large", "Imagem grande demais.");
    const stem = (filename.slice(0, filename.length - ext.length).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "imagem").slice(0, 60);
    const attachDir = join(dirname(note), "_attachments");
    this.safeMkdirp(attachDir);
    for (let n = 0; n < 1000; n++) {
      const file = `${stem}${n === 0 ? "" : `-${n}`}${ext}`;
      const abs = join(attachDir, file);
      if (existsSync(abs)) continue;
      writeFileSync(abs, data, { flag: "wx" });
      if (realpathSync(abs) !== abs) throw new NotesError("outside_root", "Caminho mudou durante a gravação.");
      return { path: `_attachments/${file}` };
    }
    throw new NotesError("exists", "Não consegui achar um nome livre para a imagem.");
  }

  /** Cria arquivo (conteúdo opcional) ou pasta. Nunca sobrescreve. */
  create(rel: string, type: "file" | "dir", content = ""): { path: string } {
    const abs = this.resolve(rel);
    if (existsSync(abs)) throw new NotesError("exists", "Já existe um item com esse nome.");
    this.safeMkdirp(dirname(abs));
    if (type === "dir") {
      mkdirSync(abs);
    } else {
      writeFileSync(abs, content, { encoding: "utf8", flag: "wx" });
    }
    if (realpathSync(abs) !== abs) throw new NotesError("outside_root", "Caminho mudou durante a criação.");
    return { path: this.relOf(abs) };
  }

  /** Renomear ou mover. Nunca sobrescreve um destino existente (nem em corrida). */
  rename(fromRel: string, toRel: string): { path: string } {
    this.refuseLink(fromRel);
    const from = this.resolve(fromRel);
    const to = this.resolve(toRel);
    if (!existsSync(from)) throw new NotesError("not_found", "Origem não encontrada.");
    if (from === to) return { path: this.relOf(to) };
    if (isInside(from, to)) {
      throw new NotesError("invalid_move", "Não dá para mover uma pasta para dentro dela mesma.");
    }
    if (existsSync(to)) {
      // Em disco sem diferenciar maiúsculas (macOS) "a.md" → "A.md" aponta para o mesmo arquivo.
      const a = statSync(from);
      const b = statSync(to);
      const same = a.ino === b.ino && a.dev === b.dev && from.toLowerCase() === to.toLowerCase();
      if (!same) throw new NotesError("exists", "Já existe um item com esse nome no destino.");
      renameSync(from, to);
      return { path: this.relOf(to) };
    }
    this.safeMkdirp(dirname(to));
    this.moveNoClobber(from, to);
    return { path: this.relOf(to) };
  }

  /**
   * Remover = mover para a lixeira. Exige confirm === true (o chamador tem de
   * ter perguntado ao usuário). Nunca apaga conteúdo do usuário.
   */
  trash(rel: string, confirm: unknown): { trashId: string; path: string } {
    if (confirm !== true) {
      throw new NotesError("not_confirmed", "Remoção exige confirmação explícita.");
    }
    this.refuseLink(rel);
    const abs = this.resolve(rel);
    if (!existsSync(abs)) throw new NotesError("not_found", "Item não encontrado.");
    this.assertTrashBase();
    const id = `${stamp()}-${randomBytes(2).toString("hex")}`;
    const bucket = join(this.root, TRASH_DIR, id);
    const dest = join(bucket, this.relOf(abs));
    this.safeMkdirp(dirname(dest));
    this.moveNoClobber(abs, dest);
    this.writeManifest(bucket, abs);
    return { trashId: id, path: this.relOf(abs) };
  }

  listTrash(): { id: string; path: string; type: "dir" | "file" }[] {
    const base = join(this.root, TRASH_DIR);
    const out: { id: string; path: string; type: "dir" | "file" }[] = [];
    try {
      const st = lstatSync(base);
      if (st.isSymbolicLink() || !st.isDirectory()) return out; // nunca enumera fora da raiz
    } catch {
      return out;
    }
    const isPlainDir = (p: string) => {
      try {
        const st = lstatSync(p);
        return st.isDirectory() && !st.isSymbolicLink();
      } catch {
        return false;
      }
    };
    const safeRel = (v: unknown): string | null => {
      if (typeof v !== "string" || v === "" || v.length > 1024) return null;
      if (v.startsWith("/") || v.includes("\\") || v.includes("\0")) return null;
      const parts = v.split("/");
      if (parts.some((x) => x === "" || x === "." || x === ".." || x.startsWith("."))) return null;
      return v;
    };
    const readManifest = (absBucket: string): string | null => {
      try {
        const mp = join(absBucket, ".item.json");
        const st = lstatSync(mp);
        if (!st.isFile() || st.isSymbolicLink() || st.size > 4096) return null; // nunca segue link
        return safeRel((JSON.parse(readFileSync(mp, "utf8")) as { path?: unknown }).path);
      } catch {
        return null;
      }
    };
    const visit = (absBucket: string, id: string) => {
      const path = readManifest(absBucket);
      if (path !== null) {
        let type: "dir" | "file" = "file";
        try {
          const target = join(absBucket, path);
          this.assertPlainChain(target);
          type = lstatSync(target).isDirectory() ? "dir" : "file";
        } catch {
          return; // entrada sem conteúdo válido
        }
        out.push({ id, path, type });
        return;
      }
      for (const name of readdirSync(absBucket)) {
        if (name.startsWith(".")) continue;
        const st = lstatSync(join(absBucket, name));
        if (st.isSymbolicLink()) continue;
        out.push({ id, path: name, type: st.isDirectory() ? "dir" : "file" });
      }
    };
    for (const name of readdirSync(base)) {
      const abs = join(base, name);
      if (!isPlainDir(abs)) continue;
      if ((BACKUP_BUCKETS as readonly string[]).includes(name)) {
        for (const sub of readdirSync(abs)) {
          const subAbs = join(abs, sub);
          if (isPlainDir(subAbs)) visit(subAbs, `${name}/${sub}`);
        }
      } else {
        visit(abs, name);
      }
    }
    return out.sort((a, b) => (a.id < b.id ? 1 : -1));
  }

  /** Devolve um item da lixeira ao lugar original (falha se o lugar estiver ocupado; nunca sobrescreve). */
  restore(id: string, rel: string): { path: string } {
    if (!/^((conflitos|versoes)\/)?[0-9A-Za-z-]+$/.test(id) || (BACKUP_BUCKETS as readonly string[]).includes(id)) {
      throw new NotesError("bad_path", "Identificador da lixeira inválido.");
    }
    const isBackup = id.includes("/");
    // `rel` passa pela mesma validação (sem .., sem oculto) antes de tocar no disco
    const target = this.resolve(rel);
    const clean = this.relOf(target);
    this.assertTrashBase();
    const src = join(this.root, TRASH_DIR, id, clean);
    this.assertPlainChain(src);
    if (!existsSync(src)) throw new NotesError("not_found", "Item não está na lixeira.");
    let finalTarget = target;
    if (existsSync(target)) {
      if (!isBackup) throw new NotesError("exists", "O lugar original já está ocupado.");
      // cópia de segurança de uma nota que ainda existe: restaura ao lado, com nome novo
      const ext = extOf(basename(target));
      const stem = basename(target).slice(0, basename(target).length - ext.length);
      const when = id.split("/")[1]!.slice(0, 10);
      for (let n = 0; n < 100; n++) {
        const alt = join(dirname(target), `${stem} (versão ${when}${n === 0 ? "" : `-${n}`})${ext}`);
        if (!existsSync(alt)) {
          finalTarget = alt;
          break;
        }
      }
      if (finalTarget === target) throw new NotesError("exists", "Não achei um nome livre para a versão.");
    }
    this.safeMkdirp(dirname(finalTarget));
    this.moveNoClobber(src, finalTarget);
    return { path: this.relOf(finalTarget) };
  }

  /** Busca por nome e (opcional) por conteúdo em arquivos de texto. */
  search(query: string, includeContent: boolean, limit = 200): SearchHit[] {
    const q = query.trim().toLowerCase();
    if (q === "") return [];
    const hits: SearchHit[] = [];
    const { entries } = this.tree();
    for (const entry of entries) {
      if (hits.length >= limit) break;
      const matchedName = entry.path.toLowerCase().includes(q);
      const snippets: { line: number; text: string }[] = [];
      if (
        includeContent &&
        entry.type === "file" &&
        (entry.kind === "markdown" || entry.kind === "html" || entry.kind === "text") &&
        entry.size <= MAX_TEXT_BYTES
      ) {
        try {
          const text = readFileSync(this.resolve(entry.path), "utf8");
          const lines = text.split("\n");
          for (let i = 0; i < lines.length && snippets.length < 3; i++) {
            const line = lines[i] ?? "";
            if (line.toLowerCase().includes(q)) {
              snippets.push({ line: i + 1, text: line.trim().slice(0, 200) });
            }
          }
        } catch {
          /* ignora arquivo ilegível */
        }
      }
      if (matchedName || snippets.length > 0) {
        hits.push({ path: entry.path, name: entry.name, type: entry.type, matchedName, snippets });
      }
    }
    return hits;
  }
}

/** HTML pronto para o iframe: assets relativos viram data: URL, sem rede. */
export function buildSandboxedHtml(
  store: NotesStore,
  rel: string,
  html: string,
): string {
  const baseDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  const budget = { left: 8 * 1024 * 1024 };
  const toDataUrl = (ref: string): string | null => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//") || ref.startsWith("#")) return null;
    const clean = ref.split("#")[0]!.split("?")[0]!;
    if (clean === "") return null;
    const joined = clean.startsWith("/") ? clean.slice(1) : baseDir === "" ? clean : `${baseDir}/${clean}`;
    const parts: string[] = [];
    for (const seg of joined.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (parts.length === 0) return null; // tentou sair da raiz
        parts.pop();
      } else parts.push(seg);
    }
    try {
      const res = store.readAsset(parts.join("/"));
      if (res.size > budget.left) return null;
      budget.left -= res.size;
      return res.dataUrl;
    } catch {
      return null;
    }
  };
  let out = html.replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi, (m, pre: string, q: string, ref: string) => {
    const data = toDataUrl(ref);
    return data === null ? m : `${pre}${q}${data}${q}`;
  });
  out = out.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
    const href = /href\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2];
    if (href === undefined || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) return "";
    const clean = href.split("?")[0]!.split("#")[0]!;
    const joined = baseDir === "" ? clean : `${baseDir}/${clean}`;
    const parts: string[] = [];
    for (const seg of joined.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (parts.length === 0) return "";
        parts.pop();
      } else parts.push(seg);
    }
    try {
      const res = store.read(parts.join("/"));
      if (res.content === null || res.size > budget.left) return "";
      budget.left -= res.size;
      return `<style>${res.content.replace(/<\/style/gi, "<\\/style")}</style>`;
    } catch {
      return "";
    }
  });
  const csp = [
    "default-src 'none'",
    "img-src data: blob:",
    "style-src 'unsafe-inline'",
    "font-src data:",
    "media-src data:",
    "script-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
  return `<meta http-equiv="Content-Security-Policy" content="${csp}">${out}`;
}

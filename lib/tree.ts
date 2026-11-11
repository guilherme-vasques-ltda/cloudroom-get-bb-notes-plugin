// Funções puras da árvore (sem React, sem Node): testáveis e usadas pelo app.
export type FlatEntry = {
  path: string;
  name: string;
  type: "dir" | "file";
  kind: "markdown" | "html" | "image" | "text" | "other" | null;
  size: number;
  mtimeMs: number;
};

export type TreeNode = FlatEntry & { children: TreeNode[]; latest: number };
export type SortMode = "name" | "modified";

const collator = new Intl.Collator("pt-BR", { numeric: true, sensitivity: "base" });

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function joinPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function ancestorsOf(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/** Resolve uma referência relativa (ex.: "../img/a.png") a partir de um arquivo. null = fora da raiz. */
export function resolveRelative(fromFile: string, ref: string): string | null {
  const clean = ref.split("#")[0]!.split("?")[0]!;
  if (clean === "") return null;
  const base = clean.startsWith("/") ? [] : parentOf(fromFile).split("/").filter(Boolean);
  const parts = [...base];
  for (const seg of clean.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  let decoded = parts.join("/");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* mantém como está */
  }
  return decoded;
}

export function buildTree(entries: FlatEntry[], sort: SortMode): TreeNode[] {
  const byPath = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  const nodes = entries.map((e) => ({ ...e, children: [] as TreeNode[], latest: e.mtimeMs }));
  for (const n of nodes) byPath.set(n.path, n);
  for (const n of nodes) {
    const parent = byPath.get(parentOf(n.path));
    (parent === undefined ? roots : parent.children).push(n);
  }
  const bump = (n: TreeNode): number => {
    for (const c of n.children) n.latest = Math.max(n.latest, bump(c));
    return n.latest;
  };
  roots.forEach(bump);
  const cmp = (a: TreeNode, b: TreeNode): number => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    if (sort === "modified" && a.latest !== b.latest) return b.latest - a.latest;
    return collator.compare(a.name, b.name);
  };
  const sortRec = (list: TreeNode[]) => {
    list.sort(cmp);
    list.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ── Caminho na URL ──────────────────────────────────────────────────────────────
// O caminho da nota vai no `subPath` do painel. Percent-encoding ("Pasta%20Exemplo") sofre com a
// camada de rotas do app (pode codificar ou decodificar de novo, e "%" vira "%25"), então o caminho
// viaja em base64url: só [A-Za-z0-9_-], que nenhuma camada altera. Formato: "<cofre>/p.<base64url>".
// Links antigos (caminho em claro) continuam abrindo.
const B64 = "p.";

export function encodeNoteSubPath(vault: string, path: string): string {
  if (path === "") return vault;
  const bytes = new TextEncoder().encode(path);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${vault}/${B64}${b64}`;
}

export function decodeNoteSubPath(subPath: string, vaultIds: string[]): { vault: string | null; path: string } {
  const parts = subPath.split("/").filter((s) => s !== "");
  const hasVault = parts.length > 0 && vaultIds.includes(parts[0]!);
  const vault = hasVault ? parts[0]! : null;
  const rest = hasVault ? parts.slice(1) : parts;
  if (rest.length === 1 && rest[0]!.startsWith(B64)) {
    try {
      const b64 = rest[0]!.slice(B64.length).replace(/-/g, "+").replace(/_/g, "/");
      const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return { vault, path: new TextDecoder().decode(bytes) };
    } catch {
      /* cai para o formato antigo */
    }
  }
  const legacy = rest.map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  return { vault, path: legacy.join("/") };
}

// Notes — frontend. Página "Notes" na barra lateral: árvore de pastas à esquerda,
// leitor/editor à direita. Fonte da verdade = arquivos no disco (o servidor do plugin
// lê/grava só dentro da pasta raiz). Compila com `room-cli plugin build`.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { definePluginApp, useBbContext, useBbNavigate, useRealtime, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMediaQuery } from "@/components/ui/hooks/use-media-query";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Editor } from "@tiptap/core";
import { VisualEditor } from "@/components/visual-editor";
import { needsMarkdownMode } from "./lib/visual-safety";
import {
  ancestorsOf,
  baseName,
  decodeNoteSubPath,
  encodeNoteSubPath,
  buildTree,
  formatBytes,
  joinPath,
  parentOf,
  resolveRelative,
  type FlatEntry,
  type SortMode,
  type TreeNode,
} from "./lib/tree";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Mode = "visual" | "source" | "split";

// A chave inclui o caminho da raiz (não só "main"): duas raízes diferentes nunca trocam rascunhos.
const draftKey = (root: string, path: string) => `notes:draft:${root}::${path}`;
type StoredDraft = { content: string; baseHash: string; at: number; session?: string };
function readDraft(root: string, path: string): StoredDraft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(root, path));
    return raw === null ? null : (JSON.parse(raw) as StoredDraft);
  } catch {
    return null;
  }
}
// Dois lugares (abas) podem ter rascunhos DIFERENTES da mesma nota: antes de substituir um rascunho de outra
// sessão por um texto diferente, o antigo vai para uma lista de arquivados (localStorage) e para uma cópia no
// servidor (`onForeign`, melhor esforço → .lixeira/conflitos). Nunca se descarta o único exemplar de um texto.
function storeDraft(root: string, path: string, d: StoredDraft, onForeign?: (old: StoredDraft) => void): boolean {
  try {
    const old = readDraft(root, path);
    if (old !== null && old.content !== d.content && old.session !== d.session) {
      try {
        const ak = `notes:draftold:${root}::${path}`;
        const list = JSON.parse(window.localStorage.getItem(ak) ?? "[]") as StoredDraft[];
        list.push(old);
        window.localStorage.setItem(ak, JSON.stringify(list.slice(-50)));
      } catch {
        // Não consegui arquivar o rascunho de outra sessão: NÃO o substituo (seria perder o único exemplar).
        toast.error("Não consegui guardar o rascunho desta nota: o armazenamento do navegador está cheio e há outro rascunho dela. Copie o texto antes de sair.");
        return false;
      }
      onForeign?.(old);
    }
    window.localStorage.setItem(draftKey(root, path), JSON.stringify(d));
    return true;
  } catch {
    toast.error("Não consegui guardar o rascunho desta nota (armazenamento do navegador cheio). Copie o texto antes de sair.");
    return false;
  }
}

// Remove o rascunho SÓ se o guardado for exatamente `content` (ações assíncronas atrasadas nunca apagam um
// rascunho mais novo, guardado depois por uma saída ou nova digitação).
function dropDraftIf(root: string, path: string, content: string): void {
  const now = readDraft(root, path);
  if (now !== null && now.content === content) {
    try {
      window.localStorage.removeItem(draftKey(root, path));
    } catch {
      /* ignorado */
    }
  }
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(`notes:${key}`);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        window.localStorage.setItem(`notes:${key}`, JSON.stringify(v));
      } catch {
        /* sem armazenamento: segue sem persistir */
      }
    },
    [key],
  );
  return [value, set];
}



// ───────────────────────────── Árvore ─────────────────────────────

type TreeCtx = {
  expanded: Set<string>;
  toggle: (p: string) => void;
  selected: string;
  onOpen: (p: string) => void;
  onRename: (n: TreeNode) => void;
  onTrash: (n: TreeNode) => void;
  onMove: (from: string, intoDir: string) => void;
  onContext: (n: TreeNode, e: { clientX: number; clientY: number }) => void;
};

function iconFor(n: FlatEntry, open: boolean) {
  if (n.type === "dir") return open ? "FolderOpen" : "Folder";
  if (n.kind === "markdown" || n.kind === "text") return "FileText";
  if (n.kind === "html") return "FileCode";
  if (n.kind === "image") return "Image";
  return "File";
}

function Row({ node, depth, ctx }: { node: TreeNode; depth: number; ctx: TreeCtx }) {
  const isDir = node.type === "dir";
  const open = ctx.expanded.has(node.path);
  const [over, setOver] = useState(false);
  return (
    <li>
      <div
        role="treeitem"
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          ctx.onContext(node, e);
        }}
        aria-expanded={isDir ? open : undefined}
        aria-selected={ctx.selected === node.path}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/x-notes-path", node.path);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          if (!isDir || !e.dataTransfer.types.includes("text/x-notes-path")) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false);
          const from = e.dataTransfer.getData("text/x-notes-path");
          if (isDir && from !== "") {
            e.preventDefault();
            ctx.onMove(from, node.path);
          }
        }}
        className={cn(
          "group flex h-7 cursor-pointer items-center gap-1.5 rounded-md pr-1 text-sm hover:bg-state-hover",
          ctx.selected === node.path && "bg-state-active",
          over && "ring-1 ring-ring bg-state-hover",
        )}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => (isDir ? ctx.toggle(node.path) : ctx.onOpen(node.path))}
        title={node.path}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {isDir ? <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5" /> : null}
        </span>
        <Icon name={iconFor(node, open)} className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          <button
            type="button"
            aria-label={`Renomear ou mover ${node.name}`}
            className="rounded p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              ctx.onRename(node);
            }}
          >
            <Icon name="Edit" className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={`Mover ${node.name} para a lixeira`}
            className="rounded p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              ctx.onTrash(node);
            }}
          >
            <Icon name="Trash2" className="size-3.5" />
          </button>
        </span>
      </div>
      {isDir && open && node.children.length > 0 ? (
        <ul role="group">
          {node.children.map((c) => (
            <Row key={c.path} node={c} depth={depth + 1} ctx={ctx} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

// ───────────────────────────── Menu de botão direito ─────────────────────────────

function ContextMenu(props: {
  x: number;
  y: number;
  node: TreeNode | null;
  onClose: () => void;
  onNew: (type: "file" | "dir") => void;
  onRename: () => void;
  onTrash: () => void;
}) {
  const { onClose } = props;
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  const where = props.node === null ? "" : props.node.type === "dir" ? " aqui dentro" : " na mesma pasta";
  const item = (label: string, onClick: () => void, danger = false) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        onClose();
        onClick();
      }}
      className={cn("flex w-full items-center rounded px-2.5 py-1.5 text-left hover:bg-state-hover", danger && "text-destructive")}
    >
      {label}
    </button>
  );
  return (
    <>
      <div
        className="fixed inset-0 z-50"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        role="menu"
        aria-label="Ações"
        className="fixed z-50 min-w-52 rounded-md border border-border bg-card p-1 text-sm shadow-lg"
        style={{ left: Math.min(props.x, window.innerWidth - 230), top: Math.min(props.y, window.innerHeight - 200) }}
      >
        {item(`Nova nota${where}`, () => props.onNew("file"))}
        {item(`Nova pasta${where}`, () => props.onNew("dir"))}
        {props.node === null ? null : (
          <>
            <div className="my-1 h-px bg-border" />
            {item("Renomear ou mover…", props.onRename)}
            {item(props.node.type === "dir" ? "Excluir pasta (vai para a lixeira)" : "Excluir nota (vai para a lixeira)", props.onTrash, true)}
          </>
        )}
      </div>
    </>
  );
}

// ───────────────────────────── Diálogos ─────────────────────────────

function NameDialog(props: {
  title: string;
  description: string;
  initial: string;
  confirmLabel: string;
  onClose: () => void;
  onSubmit: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState(props.initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    const v = value.trim();
    if (v === "" || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await props.onSubmit(v);
      props.onClose();
    } catch (e) {
      setErr(msg(e));
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : props.onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          aria-label="Nome"
        />
        {err === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {err}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={busy || value.trim() === ""}>
            {props.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TrashConfirm(props: { node: TreeNode; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const count = props.node.type === "dir" ? countFiles(props.node) : 1;
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : props.onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mover para a lixeira?</DialogTitle>
          <DialogDescription>
            “{props.node.name}”
            {props.node.type === "dir" ? ` e os ${count} arquivo(s) dentro` : ""} vai para a lixeira
            (<code>.lixeira</code> dentro da pasta de notas). Nada é apagado de verdade: você pode restaurar
            depois pelo botão Lixeira.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await props.onConfirm();
              } finally {
                props.onClose();
              }
            }}
          >
            Mover para a lixeira
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function countFiles(n: TreeNode): number {
  return n.type === "file" ? 1 : n.children.reduce((s, c) => s + countFiles(c), 0);
}

function TrashDialog(props: { rpc: Rpc; vault: string; onClose: () => void; onRestored: (p: string) => void }) {
  const [items, setItems] = useState<{ id: string; path: string; type: "dir" | "file" }[] | null>(null);
  const load = useCallback(() => {
    props.rpc.call("trash_list", { vault: props.vault }).then((r) => setItems(r.items), (e) => toast.error(msg(e)));
  }, [props.rpc, props.vault]);
  useEffect(load, [load]);
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : props.onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Lixeira</DialogTitle>
          <DialogDescription>
            Itens movidos para <code>.lixeira</code>. “Restaurar” devolve ao lugar original (se estiver livre).
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-80 overflow-y-auto">
          {items === null ? (
            <p className="text-sm text-muted-foreground">Carregando…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">A lixeira está vazia.</p>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((it) => (
                <li key={`${it.id}/${it.path}`} className="flex items-center gap-2 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{it.path}</div>
                    <div className="truncate text-xs text-muted-foreground">{it.id}</div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      props.rpc.call("trash_restore", { vault: props.vault, id: it.id, path: it.path }).then(
                        (r) => {
                          toast.success(`Restaurado: ${r.path}`);
                          props.onRestored(r.path);
                          load();
                        },
                        (e) => toast.error(msg(e)),
                      )
                    }
                  >
                    Restaurar
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────────── Editor ─────────────────────────────

function Banner(props: { tone: "warn" | "info"; children: ReactNode }) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm",
        props.tone === "warn" ? "border-destructive/40 bg-destructive/10" : "border-border bg-state-hover",
      )}
    >
      {props.children}
    </div>
  );
}

function ToolBtn(props: { label: string; title: string; onClick: () => void; active?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      aria-pressed={props.active}
      disabled={props.disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onClick}
      className={cn(
        "inline-flex h-7 min-w-7 items-center justify-center rounded px-2 text-xs font-medium text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-40",
        props.active && "bg-state-active text-foreground",
      )}
    >
      {props.label}
    </button>
  );
}

const Sep = () => <span className="mx-1 h-4 w-px bg-border" />;

/** Barra de botões do editor formatado: tudo em português, sem precisar saber Markdown. */
function VisualToolbar({ editor, onPickImage }: { editor: Editor; onPickImage: () => void }) {
  const [, tick] = useState(0);
  const [linkOpen, setLinkOpen] = useState(false);
  const [url, setUrl] = useState("");
  useEffect(() => {
    const bump = () => tick((n) => n + 1);
    editor.on("transaction", bump);
    return () => {
      editor.off("transaction", bump);
    };
  }, [editor]);
  const c = () => editor.chain().focus();
  const heading = editor.isActive("heading", { level: 1 })
    ? "1"
    : editor.isActive("heading", { level: 2 })
      ? "2"
      : editor.isActive("heading", { level: 3 })
        ? "3"
        : "0";
  const inTable = editor.isActive("table");
  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-2 py-1">
      <ToolBtn label="↶ Desfazer" title="Desfazer" onClick={() => c().undo().run()} disabled={!editor.can().undo()} />
      <ToolBtn label="↷ Refazer" title="Refazer" onClick={() => c().redo().run()} disabled={!editor.can().redo()} />
      <Sep />
      <select
        aria-label="Estilo do parágrafo"
        value={heading}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "0") c().setParagraph().run();
          else c().setHeading({ level: Number(v) as 1 | 2 | 3 }).run();
        }}
        className="h-7 rounded border border-input bg-transparent px-1 text-xs"
      >
        <option value="0">Texto normal</option>
        <option value="1">Título grande</option>
        <option value="2">Título médio</option>
        <option value="3">Título pequeno</option>
      </select>
      <ToolBtn label="Negrito" title="Negrito (⌘B)" active={editor.isActive("bold")} onClick={() => c().toggleBold().run()} />
      <ToolBtn label="Itálico" title="Itálico (⌘I)" active={editor.isActive("italic")} onClick={() => c().toggleItalic().run()} />
      <ToolBtn label="Código" title="Trecho de código" active={editor.isActive("code")} onClick={() => c().toggleCode().run()} />
      <Sep />
      <ToolBtn label="• Lista" title="Lista com marcadores" active={editor.isActive("bulletList")} onClick={() => c().toggleBulletList().run()} />
      <ToolBtn label="1. Lista" title="Lista numerada" active={editor.isActive("orderedList")} onClick={() => c().toggleOrderedList().run()} />
      <ToolBtn label="☐ Tarefas" title="Lista de tarefas" active={editor.isActive("taskList")} onClick={() => c().toggleTaskList().run()} />
      <ToolBtn label="❝ Citação" title="Citação" active={editor.isActive("blockquote")} onClick={() => c().toggleBlockquote().run()} />
      <Sep />
      <ToolBtn
        label="🔗 Link"
        title="Link"
        active={editor.isActive("link")}
        onClick={() => {
          setUrl((editor.getAttributes("link").href as string | undefined) ?? "");
          setLinkOpen((o) => !o);
        }}
      />
      <ToolBtn label="▦ Tabela" title="Inserir tabela" onClick={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} />
      <ToolBtn label="🖼 Imagem" title="Inserir imagem (ou cole/arraste uma)" onClick={onPickImage} />
      {inTable ? (
        <>
          <Sep />
          <ToolBtn label="+ Linha" title="Adicionar linha abaixo" onClick={() => c().addRowAfter().run()} />
          <ToolBtn label="+ Coluna" title="Adicionar coluna à direita" onClick={() => c().addColumnAfter().run()} />
          <ToolBtn label="− Linha" title="Remover linha" onClick={() => c().deleteRow().run()} />
          <ToolBtn label="− Coluna" title="Remover coluna" onClick={() => c().deleteColumn().run()} />
        </>
      ) : null}
      {linkOpen ? (
        <form
          className="ml-2 flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            const v = url.trim();
            if (v === "") c().unsetLink().run();
            else c().extendMarkRange("link").setLink({ href: v }).run();
            setLinkOpen(false);
          }}
        >
          <Input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… ou outra-nota.md" className="h-7 w-56 text-xs" aria-label="Endereço do link" />
          <Button size="sm" type="submit" className="h-7">
            OK
          </Button>
        </form>
      ) : null}
    </div>
  );
}

function HtmlFrame(props: { rpc: Rpc; vault: string; path: string; source: string }) {
  const [doc, setDoc] = useState<string>("");
  useEffect(() => {
    const t = setTimeout(() => {
      props.rpc
        .call("html", { vault: props.vault, path: props.path, content: props.source })
        .then((r) => setDoc(r.html), (e) => toast.error(msg(e)));
    }, 300);
    return () => clearTimeout(t);
  }, [props.rpc, props.vault, props.path, props.source]);
  // Opaco e sem scripts: sandbox vazio (nunca allow-same-origin nem allow-scripts).
  return (
    <iframe
      title={`Prévia de ${props.path}`}
      sandbox=""
      srcDoc={doc}
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-white"
    />
  );
}

function ImageView(props: { rpc: Rpc; vault: string; path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    setErr(null);
    props.rpc.call("asset", { vault: props.vault, path: props.path }).then((r) => setUrl(r.dataUrl), (e) => setErr(msg(e)));
  }, [props.rpc, props.vault, props.path]);
  return (
    <div className="flex h-full items-center justify-center overflow-auto p-6">
      {err !== null ? (
        <p className="text-sm text-destructive">{err}</p>
      ) : url === null ? (
        <p className="text-sm text-muted-foreground">Carregando imagem…</p>
      ) : (
        <img src={url} alt={props.path} className="max-h-full max-w-full object-contain" />
      )}
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Não consegui ler a imagem"));
    reader.onload = () => {
      const r = String(reader.result ?? "");
      resolve(r.slice(r.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

function FileView(props: {
  rpc: Rpc;
  vault: string;
  vaultRoot: string;
  path: string;
  wide: boolean;
  readOnly: boolean;
  onOpenPath: (p: string) => void;
  onBack: (() => void) | null;
  onCopySaved: (p: string) => void;
}) {
  const { rpc, vault, vaultRoot, path, readOnly } = props;
  const [loaded, setLoaded] = useState<{ kind: string; size: number; reason: string | null; mtimeMs: number } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [conflict, setConflict] = useState<{ content: string | null; hash: string } | null>(null);
  const [missing, setMissing] = useState(false);
  const [followed, setFollowed] = useState(false);
  const [rev, setRev] = useState(0);
  const [pendingDraft, setPendingDraftState] = useState<StoredDraft | null>(null);
  const setPendingDraft = (d: StoredDraft | null) => {
    pendingDraftRef.current = d;
    setPendingDraftState(d);
  };
  const [tiptap, setTiptap] = useState<Editor | null>(null);
  const [storedMd, setStoredMd] = useStored<Mode>("mode-md", "visual");
  const [storedHtml, setStoredHtml] = useStored<Mode>("mode-html", "visual");
  const kind = loaded?.kind ?? "other";
  const stored = kind === "html" ? storedHtml : storedMd;
  const setMode = kind === "html" ? setStoredHtml : setStoredMd;
  // Notas com sintaxe que o editor formatado reescreveria (rodapé, [[wikilink]], callout, tabela alinhada, link com
  // título, cerca com atributos, matemática…) abrem só em Markdown. Ver lib/visual-safety.ts.
  const hasFootnotes = kind === "markdown" && needsMarkdownMode(draft);
  const mode: Mode = kind === "markdown" && hasFootnotes ? "source" : !props.wide && stored === "split" ? "visual" : stored;

  const base = useRef({ content: "", hash: "" });
  const draftRef = useRef("");
  const inflight = useRef(false);
  const inflightP = useRef<Promise<"ok" | "fail"> | null>(null);
  // Depois de uma gravação que NÃO foi confirmada (conflito, removido, erro/resposta perdida) o que está no disco
  // é incerto: "texto da tela == base" deixa de significar "salvo".
  const unsure = useRef(false);
  const session = useRef(Math.random().toString(36).slice(2));
  const isDirty = () => draftRef.current !== base.current.content || unsure.current;
  // Só apaga rascunho guardado POR ESTA sessão: o de outra aba/montagem pode ser o único exemplar de um texto.
  const clearOwnDraft = () => {
    const st = readDraft(vaultRoot, path);
    if (st !== null && st.session === session.current) {
      try {
        window.localStorage.removeItem(draftKey(vaultRoot, path));
      } catch {
        /* ignorado */
      }
    }
  };
  const putDraft = (d: { content: string; baseHash: string; at: number }) =>
    storeDraft(vaultRoot, path, { ...d, session: session.current }, (old) => {
      void rpc.call("conflict_copy", { vault, path, content: old.content }).catch(() => {});
    });
  const pendingReconcile = useRef(false);
  const lastOwnHash = useRef("");
  const snapshotted = useRef(false);
  const failures = useRef(0);
  const pendingDraftRef = useRef<StoredDraft | null>(null);
  const conflictRef = useRef<typeof conflict>(null);
  const missingRef = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const imgCache = useRef(new Map<string, string>());
  conflictRef.current = conflict;
  missingRef.current = missing;

  useEffect(() => {
    let alive = true;
    setLoaded(null);
    setLoadErr(null);
    setConflict(null);
    setMissing(false);
    setFollowed(false);
    snapshotted.current = false;
    unsure.current = false;
    rpc.call("read", { vault, path }).then(
      (r) => {
        if (!alive) return;
        base.current = { content: r.content ?? "", hash: r.hash };
        draftRef.current = r.content ?? "";
        setDraft(r.content ?? "");
        setSaveState("saved");
        let stored = readDraft(vaultRoot, path);
        if (stored !== null && stored.content === (r.content ?? "") && Date.now() - stored.at > 600000) {
          // igual ao disco e antigo: não é mais necessário (as recentes ficam, pois uma gravação lenta da montagem anterior ainda pode alterar o disco)
          dropDraftIf(vaultRoot, path, stored.content);
          stored = null;
        }
        setPendingDraft(stored !== null && stored.content !== (r.content ?? "") ? stored : null);
        setLoaded({ kind: r.kind, size: r.size, reason: r.reason, mtimeMs: r.mtimeMs });
      },
      (e) => alive && setLoadErr(msg(e)),
    );
    return () => {
      alive = false;
    };
  }, [rpc, vault, vaultRoot, path]);

  const save = useCallback(async () => {
    if (readOnly || inflight.current || conflictRef.current !== null || missingRef.current) return;
    const content = draftRef.current;
    if (content === base.current.content && !unsure.current) {
      setSaveState("saved");
      return;
    }
    inflight.current = true;
    let outcome: "ok" | "fail" = "fail";
    let done: (o: "ok" | "fail") => void = () => {};
    inflightP.current = new Promise<"ok" | "fail">((r) => (done = r));
    setSaveState("saving");
    try {
      const res = await rpc.call("write", {
        vault,
        path,
        content,
        expectedHash: base.current.hash,
        snapshot: !snapshotted.current,
      });
      if (res.status === "ok") {
        outcome = "ok";
        unsure.current = false;
        snapshotted.current = true;
        base.current = { content, hash: res.hash };
        lastOwnHash.current = res.hash;
        failures.current = 0;
        if (pendingDraftRef.current === null) dropDraftIf(vaultRoot, path, content);
        setSaveState(draftRef.current === content ? "saved" : "dirty");
      } else if (res.status === "conflict") {
        unsure.current = true;
        setConflict({ content: res.currentContent, hash: res.currentHash });
        setSaveState("dirty");
      } else {
        unsure.current = true;
        setMissing(true);
        setSaveState("dirty");
      }
    } catch (e) {
      unsure.current = true;
      failures.current += 1;
      if (failures.current <= 2) toast.error(`Não consegui salvar: ${msg(e)}`);
      setSaveState("error");
      // tenta de novo sozinho com espera crescente (1,4 s, 2,8 s … até 20 s) e desiste após 6 falhas seguidas;
      // uma nova digitação ou Ctrl+S sempre tenta de novo
      if (failures.current <= 6) {
        const wait = Math.min(700 * 2 ** failures.current, 20000);
        setTimeout(() => setRev((r) => r + 1), wait);
      }
    } finally {
      inflight.current = false;
      inflightP.current = null;
      done(outcome);
      if (failures.current === 0 && !conflictRef.current && !missingRef.current && isDirty()) setRev((r) => r + 1);
    }
  }, [rpc, vault, vaultRoot, path, readOnly]);

  // Salvamento automático (700 ms depois da última alteração)
  useEffect(() => {
    if (readOnly || loaded === null || conflict !== null || missing) return;
    if (!isDirty()) {
      setSaveState((s) => (s === "dirty" ? "saved" : s)); // desfez até ficar igual ao disco
      return;
    }
    setSaveState((s) => (s === "saving" ? s : "dirty"));
    const t = setTimeout(() => void save(), 700);
    return () => clearTimeout(t);
  }, [draft, loaded, conflict, missing, rev, save, readOnly]);

  // Rascunho SEMPRE em dia: enquanto houver texto não confirmado em disco, guarda uma cópia no navegador
  // (400 ms depois da última alteração) e também ao fechar/ocultar a aba. Apagada só quando a gravação é confirmada.
  useEffect(() => {
    if (readOnly || loaded === null || pendingDraft !== null) return;
    if (!isDirty()) {
      clearOwnDraft(); // o texto voltou a ser igual ao do disco: nada a recuperar
      return;
    }
    const t = setTimeout(() => {
      if (isDirty()) {
        putDraft({ content: draftRef.current, baseHash: base.current.hash, at: Date.now() });
      }
    }, 400);
    return () => clearTimeout(t);
  }, [draft, loaded, readOnly, pendingDraft, vaultRoot, path]);
  useEffect(() => {
    const flush = () => {
      if (readOnly || pendingDraftRef.current !== null || !isDirty()) return;
      putDraft({ content: draftRef.current, baseHash: base.current.hash, at: Date.now() });
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, [readOnly, vaultRoot, path]);

  // Ao sair do arquivo com texto não salvo: guarda o rascunho ANTES de depender da resposta do servidor
  // e só o apaga quando a gravação desse mesmo texto for confirmada. Se um rascunho antigo estava sendo
  // oferecido (e foi ignorado), ele só é substituído quando a gravação do texto novo falha.
  useEffect(
    () => () => {
      if (readOnly) return;
      const pendingSave = inflightP.current;
      if (pendingSave !== null) {
        // Há uma gravação em andamento (de outro texto). O texto da tela pode ser diferente do que está sendo
        // gravado (ex.: desfez até o texto anterior): guarda um rascunho já e, quando a gravação terminar,
        // regrava o que estava na tela se o disco ficou diferente dele.
        const content = draftRef.current;
        const hadOffer = pendingDraftRef.current !== null;
        const stored = hadOffer ? false : putDraft({ content, baseHash: base.current.hash, at: Date.now() });
        const dropIfSame = () => dropDraftIf(vaultRoot, path, content);
        const keep = () => {
          if (hadOffer) putDraft({ content, baseHash: base.current.hash, at: Date.now() });
        };
        void pendingSave.then(async (outcome) => {
          // conflito, arquivo removido ou erro: a gravação em curso NÃO ficou no disco como esperado; o rascunho fica.
          if (outcome !== "ok") {
            keep();
            return;
          }
          if (content === base.current.content && !unsure.current) {
            if (stored) dropIfSame();
            return;
          }
          if (conflictRef.current !== null || missingRef.current) {
            keep();
            return;
          }
          try {
            const res = await rpc.call("write", { vault, path, content, expectedHash: base.current.hash, snapshot: false });
            if (res.status === "ok") {
              if (stored) dropIfSame();
            } else keep();
          } catch {
            keep();
          }
        });
        return;
      }
      if (!isDirty()) return;
      const content = draftRef.current;
      const baseHash = base.current.hash;
      const hadOffer = pendingDraftRef.current !== null;
      let stored = false;
      if (!hadOffer) stored = putDraft({ content, baseHash, at: Date.now() });
      if (conflictRef.current !== null || missingRef.current) {
        if (hadOffer) putDraft({ content, baseHash, at: Date.now() });
        return;
      }
      void rpc
        .call("write", { vault, path, content, expectedHash: baseHash, snapshot: !snapshotted.current })
        .then((res) => {
          if (res.status !== "ok") {
            if (hadOffer) putDraft({ content, baseHash, at: Date.now() });
            return;
          }
          if (!stored) return;
          dropDraftIf(vaultRoot, path, content);
        })
        .catch(() => {
          if (hadOffer) putDraft({ content, baseHash, at: Date.now() });
        });
    },
    [rpc, vault, vaultRoot, path, readOnly],
  );

  // Atualização ao vivo: o arquivo mudou no disco?
  const reconcileSeq = useRef(0);
  const reconcile = useCallback(async () => {
    if (inflight.current) {
      pendingReconcile.current = true;
      return;
    }
    const seq = ++reconcileSeq.current;
    let r;
    try {
      r = await rpc.call("read", { vault, path });
    } catch (e) {
      if (seq === reconcileSeq.current && /não encontrado/i.test(msg(e))) setMissing(true);
      return;
    }
    if (seq !== reconcileSeq.current || inflight.current) return; // resposta atrasada ou gravação em curso: ignora
    if (missingRef.current) setMissing(false); // o arquivo voltou
    if (r.content === null) return;
    if (r.hash === base.current.hash || r.hash === lastOwnHash.current) {
      if (r.hash === base.current.hash) unsure.current = false;
      if (conflictRef.current !== null && r.hash === base.current.hash) setConflict(null);
      return;
    }
    if (conflictRef.current !== null || isDirty()) {
      setConflict({ content: r.content, hash: r.hash }); // há texto meu não salvo → perguntar
      return;
    }
    base.current = { content: r.content, hash: r.hash };
    draftRef.current = r.content;
    setDraft(r.content);
    const keptDraft = readDraft(vaultRoot, path);
    if (keptDraft !== null && keptDraft.content !== r.content && pendingDraftRef.current === null) setPendingDraft(keptDraft); // rascunho de antes: oferecer
    setFollowed(true);
    setLoaded((l) => (l === null ? l : { ...l, size: r.size, mtimeMs: r.mtimeMs }));
  }, [rpc, vault, vaultRoot, path]);

  useRealtime("notes-changed", (payload) => {
    const p = payload as { vault?: string; paths?: string[] } | null;
    if (p?.vault !== vault) return;
    if (p.paths !== undefined && p.paths.length > 0 && !p.paths.includes(path)) return;
    void reconcile();
  });
  useEffect(() => {
    // Rede de segurança caso o watcher do sistema falhe: confere a cada 8 s.
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void reconcile();
    }, 8000);
    return () => clearInterval(t);
  }, [reconcile]);
  useEffect(() => {
    if (!inflight.current && pendingReconcile.current) {
      pendingReconcile.current = false;
      void reconcile();
    }
  }, [rev, saveState, reconcile]);

  const keepMine = async () => {
    if (conflict === null) return;
    const sent = draftRef.current; // o que foi enviado; o que for digitado depois continua pendente
    try {
      const res = await rpc.call("write", { vault, path, content: sent, expectedHash: conflict.hash, keepMine: true });
      if (res.status === "ok") {
        snapshotted.current = true;
        base.current = { content: sent, hash: res.hash };
        lastOwnHash.current = res.hash;
        unsure.current = false;
        dropDraftIf(vaultRoot, path, sent);
        setConflict(null);
        setSaveState(draftRef.current === sent ? "saved" : "dirty");
        setRev((r) => r + 1);
        toast.success("Mantive a sua versão. A versão deles ficou na lixeira (conflitos).");
      } else if (res.status === "conflict") {
        setConflict({ content: res.currentContent, hash: res.currentHash });
        toast.error("O arquivo mudou de novo. Decida outra vez.");
      } else setMissing(true);
    } catch (e) {
      toast.error(msg(e));
    }
  };
  const taking = useRef(false);
  const takeTheirs = async () => {
    if (conflict === null || conflict.content === null || taking.current) return;
    taking.current = true;
    try {
      await takeTheirsInner();
    } finally {
      taking.current = false;
    }
  };
  const takeTheirsInner = async () => {
    if (conflict === null || conflict.content === null) return;
    if (!readOnly && isDirty()) {
      // Guarda o texto do usuário e só troca quando a cópia cobre EXATAMENTE o que está na tela;
      // se ele digitou durante a cópia, copia de novo (sem nunca descartar texto não copiado).
      let copied = "";
      let ok = false;
      for (let i = 0; i < 6 && !ok; i++) {
        const sent = draftRef.current;
        try {
          await rpc.call("conflict_copy", { vault, path, content: sent });
        } catch (e) {
          toast.error(`Não descartei o seu texto porque não consegui guardá-lo: ${msg(e)}`);
          return;
        }
        copied = sent;
        ok = draftRef.current === copied;
      }
      if (!ok) {
        toast.error("Você continuou digitando durante a cópia. Pare de digitar e clique de novo em “Pegar o deles”.");
        return;
      }
      toast.success("Seu texto foi guardado na lixeira (conflitos).");
    }
    // daqui até setDraft não há await: nada pode ser digitado entre a conferência e a troca
    const mine = draftRef.current;
    unsure.current = false;
    base.current = { content: conflict.content, hash: conflict.hash };
    draftRef.current = conflict.content;
    setDraft(conflict.content);
    setConflict(null);
    setSaveState("saved");
    setPendingDraft(null);
    if (!readOnly) dropDraftIf(vaultRoot, path, mine); // o meu texto já está em .lixeira/conflitos (em somente leitura não há cópia: o rascunho fica)
  };
  const saveCopy = async () => {
    const dir = parentOf(path);
    const stem = baseName(path).replace(/\.[^.]+$/, "");
    const ext = baseName(path).slice(stem.length) || ".md";
    const target = joinPath(dir, `${stem} (cópia)${ext}`);
    try {
      await rpc.call("create", { vault, path: target, type: "file", content: draftRef.current });
      toast.success(`Cópia salva: ${target}`);
      props.onCopySaved(target);
    } catch (e) {
      toast.error(msg(e));
    }
  };

  const onChange = useCallback((v: string) => {
    draftRef.current = v;
    setDraft(v);
  }, []);
  // O <textarea> do navegador troca CRLF por LF: mostramos LF e devolvemos CRLF ao salvar,
  // para arquivos com quebras Windows não serem reescritos por inteiro.
  const crlf = /\r\n/.test(base.current.content) || (draft.includes("\r\n") && !draft.replace(/\r\n/g, "").includes("\n"));
  const resolveImage = useCallback(
    async (src: string): Promise<string | null> => {
      const target = resolveRelative(path, src);
      if (target === null) return null;
      const hit = imgCache.current.get(target);
      if (hit !== undefined) return hit;
      try {
        const r = await rpc.call("asset", { vault, path: target });
        imgCache.current.set(target, r.dataUrl);
        return r.dataUrl;
      } catch {
        return null;
      }
    },
    [rpc, vault, path],
  );
  const uploadImage = useCallback(
    async (file: File): Promise<string> => {
      try {
        const r = await rpc.call("upload_image", { vault, note: path, name: file.name || "imagem.png", base64: await fileToBase64(file) });
        return r.path;
      } catch (e) {
        toast.error(`Não consegui inserir a imagem: ${msg(e)}`);
        throw e;
      }
    },
    [rpc, vault, path],
  );
  const openLink = useCallback(
    (href: string) => {
      if (/^(https?:|mailto:)/i.test(href)) {
        window.open(href, "_blank", "noopener,noreferrer");
        return;
      }
      const target = resolveRelative(path, href);
      if (target !== null) props.onOpenPath(target);
    },
    [path, props],
  );

  const exec = (cmd: "undo" | "redo") => {
    taRef.current?.focus();
    document.execCommand(cmd);
  };
  const insert = (prefix: string, suffix = "", placeholder = "") => {
    const ta = taRef.current;
    if (ta === null) return;
    ta.focus();
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd) || placeholder;
    document.execCommand("insertText", false, `${prefix}${sel}${suffix}`);
  };
  const linePrefix = (prefix: string) => {
    const ta = taRef.current;
    if (ta === null) return;
    ta.focus();
    const start = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
    ta.setSelectionRange(start, start);
    document.execCommand("insertText", false, prefix);
  };

  if (loadErr !== null) {
    return (
      <div className="p-6 text-sm">
        <p className="text-destructive">{loadErr}</p>
        <p className="mt-1 text-xs text-muted-foreground">Caminho pedido: {path}</p>
      </div>
    );
  }
  if (loaded === null) return <div className="p-6 text-sm text-muted-foreground">Carregando…</div>;

  const editable = loaded.reason === null && (kind === "markdown" || kind === "html" || kind === "text");
  const statusLabel = readOnly
    ? "Somente leitura"
    : conflict !== null
      ? "Conflito"
      : missing
        ? "Arquivo sumiu"
        : saveState === "saving"
          ? "Salvando…"
          : saveState === "dirty"
            ? "Não salvo"
            : saveState === "error"
              ? "Erro ao salvar"
              : "Salvo";
  const isMd = kind === "markdown";
  const showVisual = editable && isMd && mode === "visual";
  const showSource = editable && (kind === "text" || (isMd && mode === "source") || (kind === "html" && mode !== "visual"));
  const showHtmlPreview = editable && kind === "html" && mode !== "source";
  const modes: { id: Mode; label: string }[] = isMd
    ? [
        { id: "visual", label: "Formatado" },
        { id: "source", label: "Markdown" },
      ]
    : [
        { id: "visual", label: "Visualizar" },
        { id: "source", label: "Código" },
        ...(props.wide ? [{ id: "split" as Mode, label: "Dividido" }] : []),
      ];

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          void save();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        {props.onBack === null ? null : (
          <Button variant="ghost" size="sm" onClick={props.onBack} aria-label="Voltar para a lista">
            <Icon name="ChevronLeft" className="size-4" />
          </Button>
        )}
        <div className="min-w-0 flex-1 truncate text-sm font-medium" title={path}>
          {path}
        </div>
        {editable ? (
          <span
            data-testid="save-status"
            className={cn(
              "rounded-full px-2 py-0.5 text-xs",
              statusLabel === "Salvo" ? "text-muted-foreground" : "bg-state-hover text-foreground",
              (conflict !== null || missing || saveState === "error") && "text-destructive",
            )}
          >
            {statusLabel}
          </span>
        ) : null}
        {editable && kind !== "text" ? (
          <div role="group" aria-label="Modo" className="flex rounded-md border border-border p-0.5">
            {modes.map((m) => (
              <button
                key={m.id}
                type="button"
                disabled={hasFootnotes && m.id === "visual"}
                title={hasFootnotes && m.id === "visual" ? "Esta nota usa sintaxe (rodapé, [[link]], callout, tabela alinhada, link com título, cerca de código com atributos, $$…$$ etc.) que o editor formatado alteraria. Edite em Markdown." : undefined}
                aria-pressed={mode === m.id}
                onClick={() => setMode(m.id)}
                className={cn("rounded px-2 py-0.5 text-xs hover:bg-state-hover", mode === m.id && "bg-state-active font-medium")}
              >
                {m.label}
              </button>
            ))}
          </div>
        ) : null}

      </div>

      {pendingDraft !== null && conflict === null ? (
        <Banner tone="warn">
          <Icon name="AlertTriangle" className="size-4" />
          <span className="flex-1">
            Há um rascunho não salvo desta nota ({new Date(pendingDraft.at).toLocaleString("pt-BR")}). Ele não foi gravado
            porque o arquivo mudou ou não foi possível salvar. Escolha o que fazer antes de continuar editando.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              draftRef.current = pendingDraft.content;
              setDraft(pendingDraft.content);
              setPendingDraft(null); // a cópia guardada só some quando a gravação for confirmada
            }}
          >
            Restaurar rascunho
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const offered = pendingDraft.content;
              setPendingDraft(null);
              dropDraftIf(vaultRoot, path, offered); // só o rascunho que foi oferecido; outro mais novo fica
            }}
          >
            Descartar
          </Button>
        </Banner>
      ) : null}
      {conflict !== null ? (
        <Banner tone="warn">
          <Icon name="AlertTriangle" className="size-4" />
          <span className="flex-1">Este arquivo mudou no disco enquanto você editava. Nada foi sobrescrito.</span>
          <Button size="sm" variant="outline" onClick={() => void keepMine()}>
            Manter o meu
          </Button>
          <Button size="sm" variant="outline" disabled={conflict.content === null} onClick={() => void takeTheirs()}>
            Pegar o deles
          </Button>
        </Banner>
      ) : null}
      {missing ? (
        <Banner tone="warn">
          <Icon name="AlertTriangle" className="size-4" />
          <span className="flex-1">Este arquivo foi movido ou apagado por fora. Não vou recriá-lo.</span>
          <Button size="sm" variant="outline" onClick={() => void saveCopy()}>
            Salvar uma cópia
          </Button>
        </Banner>
      ) : null}
      {followed && conflict === null ? (
        <Banner tone="info">
          <span className="flex-1">Atualizado: o arquivo mudou no disco e esta tela acompanhou.</span>
          <Button size="sm" variant="ghost" onClick={() => setFollowed(false)}>
            OK
          </Button>
        </Banner>
      ) : null}

      {showVisual && tiptap !== null && !readOnly && pendingDraft === null && conflict === null && !missing ? (
        <>
          <VisualToolbar editor={tiptap} onPickImage={() => fileInput.current?.click()} />
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f === undefined) return;
              try {
                const rel = await uploadImage(f);
                tiptap.chain().focus().setImage({ src: rel, alt: f.name }).run();
              } catch {
                /* erro já mostrado */
              }
            }}
          />
        </>
      ) : null}
      {showSource && editable && kind !== "html" && isMd && !readOnly && pendingDraft === null ? (
        <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-2 py-1">
          <ToolBtn label="↶" title="Desfazer" onClick={() => exec("undo")} />
          <ToolBtn label="↷" title="Refazer" onClick={() => exec("redo")} />
          <Sep />
          <ToolBtn label="N" title="Negrito" onClick={() => insert("**", "**", "texto")} />
          <ToolBtn label="I" title="Itálico" onClick={() => insert("*", "*", "texto")} />
          <ToolBtn label="H2" title="Título" onClick={() => linePrefix("## ")} />
          <ToolBtn label="•" title="Lista" onClick={() => linePrefix("- ")} />
          <ToolBtn label="1." title="Lista numerada" onClick={() => linePrefix("1. ")} />
          <ToolBtn label="☐" title="Tarefa" onClick={() => linePrefix("- [ ] ")} />
          <ToolBtn label="❝" title="Citação" onClick={() => linePrefix("> ")} />
          <ToolBtn label="</>" title="Código" onClick={() => insert("`", "`", "código")} />
          <ToolBtn label="🔗" title="Link" onClick={() => insert("[", "](url)", "texto")} />
        </div>
      ) : null}

      <div className={cn("min-h-0 flex-1", showSource && showHtmlPreview ? "grid grid-cols-2 divide-x divide-border" : "")}>
        {kind === "image" ? (
          <ImageView rpc={rpc} vault={vault} path={path} />
        ) : !editable ? (
          <div className="p-6 text-sm text-muted-foreground">
            {loaded.reason === "too_large"
              ? `Arquivo grande demais para abrir aqui (${formatBytes(loaded.size)}).`
              : loaded.reason === "binary"
                ? "Este arquivo não é texto UTF-8; para não corrompê-lo, só abro em outro programa."
                : `Tipo de arquivo sem visualizador aqui (${formatBytes(loaded.size)}).`}
          </div>
        ) : (
          <>
            {showVisual ? (
              <VisualEditor
                value={draft}
                onMarkdownChange={(md) => onChange(/\r\n/.test(base.current.content) && !/(^|[^\r])\n/.test(base.current.content) ? md.replace(/\r?\n/g, "\r\n") : md)}
                resolveImage={resolveImage}
                uploadImage={uploadImage}
                onOpenLink={openLink}
                onReady={setTiptap}
                disabled={readOnly || conflict !== null || missing || pendingDraft !== null}
              />
            ) : null}
            {showSource ? (
              <textarea
                ref={taRef}
                data-testid="editor"
                value={crlf ? draft.replace(/\r\n/g, "\n") : draft}
                onChange={(e) => onChange(crlf ? e.target.value.replace(/\r?\n/g, "\r\n") : e.target.value)}
                spellCheck={false}
                readOnly={readOnly || pendingDraft !== null}
                aria-label={`Editor de ${path}`}
                className="h-full min-h-0 w-full resize-none bg-transparent px-5 py-4 font-mono text-[13px] leading-6 outline-none"
              />
            ) : null}
            {showHtmlPreview ? <HtmlFrame rpc={rpc} vault={vault} path={path} source={draft} /> : null}
          </>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────── Página ─────────────────────────────

type VaultInfo = { id: string; name: string; root: string; error: string | null };

function NotesPage({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const sdk = useSdk();
  const bbCtx = useBbContext();
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [scopeStored, setScopeStored] = useStored<string | null>("scope", null);
  const wide = useMediaQuery("(min-width: 1100px)");
  const compact = useMediaQuery("(max-width: 767px)");
  const [vaults, setVaults] = useState<VaultInfo[] | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; node: TreeNode | null } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const readOnlyNotice = () =>
    toast.error("Somente leitura: criar, renomear e excluir estão desligados por segurança até a escrita ser liberada.");
  const [vaultsErr, setVaultsErr] = useState<string | null>(null);
  const [entries, setEntries] = useState<FlatEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [treeErr, setTreeErr] = useState<string | null>(null);
  const [sort, setSort] = useStored<SortMode>("sort", "name");
  const [query, setQuery] = useState("");
  const [inContent, setInContent] = useStored<boolean>("search-content", true);
  const [hits, setHits] = useState<
    { path: string; name: string; type: "dir" | "file"; matchedName: boolean; snippets: { line: number; text: string }[] }[] | null
  >(null);
  const [dialog, setDialog] = useState<
    | { kind: "new"; type: "file" | "dir"; dir: string }
    | { kind: "rename"; node: TreeNode }
    | { kind: "trash"; node: TreeNode }
    | { kind: "lixeira" }
    | null
  >(null);

  // subPath = "<cofre>/<caminho do arquivo>"
  const decoded = decodeNoteSubPath(subPath, (vaults ?? []).map((v) => v.id));
  const vault = (decoded.vault !== null && vaults?.some((v) => v.id === decoded.vault) ? decoded.vault : null) ?? vaults?.[0]?.id ?? "main";
  const selected = decoded.path;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [storedExp, setStoredExp] = useStored<string[]>(`expanded:${vault}`, []);
  useEffect(() => setExpanded(new Set(storedExp)), [vault]); // eslint-disable-line react-hooks/exhaustive-deps

  const openPath = useCallback(
    (p: string, replace = false) => {
      nav.toPluginPanel("notes", { subPath: encodeNoteSubPath(vault, p), replace });
    },
    [nav, vault],
  );

  // Configuração viva: relê cofres e "somente leitura" ao abrir, a cada 10 s e ao voltar para a aba,
  // para a tela acompanhar mudanças de configuração sem precisar recarregar o painel.
  useEffect(() => {
    let alive = true;
    const load = () =>
      rpc.call("vaults", null).then(
        (r) => {
          if (!alive) return;
          setReadOnly(r.readOnly);
          setVaultsErr(null);
          setVaults((prev) => (JSON.stringify(prev) === JSON.stringify(r.vaults) ? prev : r.vaults));
        },
        (e) => alive && setVaultsErr(msg(e)),
      );
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 10000);
    const onVis = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [rpc]);

  const refreshTree = useCallback(() => {
    if (vaults === null || vaults.length === 0) return;
    rpc.call("tree", { vault }).then(
      (r) => {
        setEntries(r.entries);
        setTruncated(r.truncated);
        setTreeErr(null);
      },
      (e) => setTreeErr(msg(e)),
    );
  }, [rpc, vault, vaults]);
  useEffect(refreshTree, [refreshTree]);

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useRealtime("notes-changed", (payload) => {
    if ((payload as { vault?: string } | null)?.vault !== vault) return;
    if (debounce.current !== null) clearTimeout(debounce.current);
    debounce.current = setTimeout(refreshTree, 200);
  });
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") refreshTree();
    }, 15000);
    return () => clearInterval(t);
  }, [refreshTree]);

  // Abre as pastas que levam ao arquivo selecionado
  useEffect(() => {
    if (selected === "") return;
    setExpanded((prev) => {
      const next = new Set(prev);
      ancestorsOf(selected).forEach((a) => next.add(a));
      return next;
    });
  }, [selected]);

  const toggle = useCallback(
    (p: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(p)) next.delete(p);
        else next.add(p);
        setStoredExp([...next]);
        return next;
      });
    },
    [setStoredExp],
  );

  // Busca (nome + conteúdo)
  useEffect(() => {
    const q = query.trim();
    if (q === "") {
      setHits(null);
      return;
    }
    const t = setTimeout(() => {
      rpc.call("search", { vault, query: q, content: inContent }).then((r) => setHits(r.hits), (e) => toast.error(msg(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [rpc, vault, query, inContent]);

  // Projetos do Cloudroom (para ligar cada projeto a uma pasta Notes/<projeto>)
  useEffect(() => {
    let alive = true;
    Promise.resolve(sdk.projects.list())
      .then((list) => alive && setProjects((list as { id: string; name: string; isPersonal?: boolean }[]).filter((p) => p.isPersonal !== true).map((p) => ({ id: p.id, name: p.name }))))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [sdk]);
  const topDirs = useMemo(() => entries.filter((e) => e.type === "dir" && !e.path.includes("/")).map((e) => e.name), [entries]);
  const norm = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const folderOfProject = useCallback((name: string) => topDirs.find((d) => norm(d) === norm(name)) ?? null, [topDirs]);
  // Escopo: "" = todas as notas; senão uma pasta de topo (ex.: Orion, Acme).
  // Padrão: a pasta do projeto aberto no Cloudroom, se existir.
  const autoScope = useMemo(() => {
    const proj = projects.find((x) => x.id === bbCtx.projectId);
    return proj === undefined ? null : folderOfProject(proj.name);
  }, [projects, bbCtx.projectId, folderOfProject]);
  const scope = scopeStored ?? autoScope ?? "";
  const underScope = useCallback((p: string) => scope === "" || p === scope || p.startsWith(`${scope}/`), [scope]);
  const scopedEntries = useMemo(() => entries.filter((e) => e.path !== scope && underScope(e.path)), [entries, scope, underScope]);
  const tree = useMemo(() => buildTree(scopedEntries, sort), [scopedEntries, sort]);
  const nodeByPath = useMemo(() => {
    const m = new Map<string, TreeNode>();
    const walk = (l: TreeNode[]) => l.forEach((n) => (m.set(n.path, n), walk(n.children)));
    walk(tree);
    return m;
  }, [tree]);

  const selectedNode = nodeByPath.get(selected);
  const targetDir =
    selectedNode === undefined ? scope : selectedNode.type === "dir" ? selectedNode.path : parentOf(selectedNode.path);

  // Abriu algo fora da pasta do projeto (ex.: por um link)? volta para "todas as notas".
  useEffect(() => {
    if (selected !== "" && !underScope(selected) && scopeStored !== "") setScopeStored("");
  }, [selected, underScope, scopeStored, setScopeStored]);

  const doMove = useCallback(
    async (from: string, intoDir: string) => {
      const to = joinPath(intoDir, baseName(from));
      if (to === from) return;
      try {
        await rpc.call("rename", { vault, from, to });
        if (selected === from) openPath(to, true);
        refreshTree();
        toast.success(`Movido para “${intoDir === "" ? "raiz" : intoDir}”.`, {
          duration: 12000,
          action: {
            label: "Desfazer",
            onClick: () => {
              rpc.call("rename", { vault, from: to, to: from }).then(
                () => {
                  refreshTree();
                  if (selected === from) openPath(from, true);
                },
                (e) => toast.error(msg(e)),
              );
            },
          },
        });
      } catch (e) {
        toast.error(msg(e));
      }
    },
    [rpc, vault, selected, openPath, refreshTree],
  );

  const ctx: TreeCtx = {
    expanded,
    toggle,
    selected,
    onOpen: (p) => openPath(p),
    onRename: (n) => (readOnly ? readOnlyNotice() : setDialog({ kind: "rename", node: n })),
    onTrash: (n) => (readOnly ? readOnlyNotice() : setDialog({ kind: "trash", node: n })),
    onMove: (from, into) => (readOnly ? readOnlyNotice() : void doMove(from, into)),
    onContext: (n, e) => setMenu({ x: e.clientX, y: e.clientY, node: n }),
  };

  if (vaultsErr !== null) return <p className="p-6 text-sm text-destructive">{vaultsErr}</p>;
  if (vaults === null) return <p className="p-6 text-sm text-muted-foreground">Carregando…</p>;
  if (vaults.length === 0) {
    return (
      <div className="mx-auto max-w-xl p-8 text-sm">
        <h2 className="mb-2 text-base font-semibold">Configure a pasta de notas</h2>
        <p className="text-muted-foreground">
          O plugin Notes ainda não sabe qual pasta mostrar. Defina a pasta raiz (o plugin só lê e grava dentro dela):
        </p>
        <pre className="mt-3 rounded-md bg-state-hover p-3 text-xs">room-cli plugin config notes set root ~/Notes{"\n"}room-cli plugin reload notes</pre>
      </div>
    );
  }
  const current = vaults.find((v) => v.id === vault)!;
  if (current.error !== null) {
    return (
      <div className="mx-auto max-w-xl p-8 text-sm">
        <p className="text-destructive">{current.error}</p>
        <p className="mt-2 text-muted-foreground">Pasta configurada: {current.root}</p>
      </div>
    );
  }

  const showList = !compact || selected === "";
  const showFile = !compact || selected !== "";

  const treePane = (
    <aside className={cn("flex min-h-0 flex-col border-border", compact ? "w-full" : "w-[300px] shrink-0 border-r")}>
      <div className="flex items-center gap-1 border-b border-border px-2 py-2">
        {vaults.length > 1 ? (
          <select
            aria-label="Cofre"
            value={vault}
            onChange={(e) => nav.toPluginPanel("notes", { subPath: e.target.value })}
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
          >
            {vaults.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        ) : (
          <div className="min-w-0 flex-1 px-1 text-xs text-muted-foreground">{readOnly ? "Somente leitura" : ""}</div>
        )}
        <Button size="icon" variant="ghost" className="size-8" title="Nova nota" aria-label="Nova nota" onClick={() => (readOnly ? readOnlyNotice() : setDialog({ kind: "new", type: "file", dir: targetDir }))}>
          <Icon name="Plus" className="size-4" />
        </Button>
        <Button size="icon" variant="ghost" className="size-8" title="Nova pasta" aria-label="Nova pasta" onClick={() => (readOnly ? readOnlyNotice() : setDialog({ kind: "new", type: "dir", dir: targetDir }))}>
          <Icon name="FolderPlus" className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          title={sort === "name" ? "Ordenado por nome (clique: mais recentes primeiro)" : "Mais recentes primeiro (clique: por nome)"}
          aria-label="Ordenar"
          onClick={() => setSort(sort === "name" ? "modified" : "name")}
        >
          <Icon name="Sort" className="size-4" />
        </Button>
        <Button size="icon" variant="ghost" className="size-8" title="Lixeira" aria-label="Lixeira" onClick={() => setDialog({ kind: "lixeira" })}>
          <Icon name="ArchiveRestore" className="size-4" />
        </Button>
      </div>
      <div className="px-2 pt-2">
        <select
          aria-label="Projeto"
          value={scope}
          onChange={async (e) => {
            const v = e.target.value;
            if (v.startsWith("__new:")) {
              const name = v.slice(6);
              try {
                await rpc.call("create", { vault, path: name, type: "dir" });
                refreshTree();
                setScopeStored(name);
              } catch (err) {
                toast.error(msg(err));
              }
              return;
            }
            setScopeStored(v);
          }}
          className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
        >
          <option value="">Todas as notas</option>
          {projects.length > 0 ? (
            <optgroup label="Projetos do Cloudroom">
              {projects.map((pr) => {
                const folder = folderOfProject(pr.name);
                return folder === null ? (
                  <option key={pr.id} value={`__new:${pr.name}`}>
                    {pr.name} (criar pasta)
                  </option>
                ) : (
                  <option key={pr.id} value={folder}>
                    {pr.name}
                  </option>
                );
              })}
            </optgroup>
          ) : null}
          <optgroup label="Outras pastas">
            {topDirs
              .filter((d) => !projects.some((pr) => folderOfProject(pr.name) === d))
              .map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
          </optgroup>
        </select>
      </div>
      <div className="flex items-center gap-1 px-2 py-2">
        <div className="relative flex-1">
          <Icon name="Search" className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar nome ou conteúdo"
            aria-label="Buscar"
            className="h-8 pl-7 text-sm"
          />
        </div>
        <button
          type="button"
          aria-pressed={inContent}
          title="Buscar também dentro dos arquivos"
          onClick={() => setInContent(!inContent)}
          className={cn("h-8 rounded-md border border-input px-2 text-xs hover:bg-state-hover", inContent && "bg-state-active")}
        >
          texto
        </button>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-1 pb-3"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, node: null });
        }}
      >
        {treeErr !== null ? <p className="px-2 py-2 text-sm text-destructive">{treeErr}</p> : null}
        {hits !== null ? (
          hits.filter((h) => underScope(h.path)).length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">Nada encontrado.</p>
          ) : (
            <ul>
              {hits.filter((h) => underScope(h.path)).map((h) => (
                <li key={h.path}>
                  <button
                    type="button"
                    onClick={() => (h.type === "file" ? openPath(h.path) : (setQuery(""), toggle(h.path)))}
                    className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover"
                  >
                    <div className="flex items-center gap-1.5">
                      <Icon name={h.type === "dir" ? "Folder" : "FileText"} className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{h.path}</span>
                    </div>
                    {h.snippets.map((s) => (
                      <div key={s.line} className="ml-5 truncate text-xs text-muted-foreground">
                        {s.line}: {s.text}
                      </div>
                    ))}
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : tree.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">Pasta vazia. Crie a primeira nota com “+”.</p>
        ) : (
          <ul role="tree" aria-label="Notas">
            {tree.map((n) => (
              <Row key={n.path} node={n} depth={0} ctx={ctx} />
            ))}
          </ul>
        )}
        {truncated ? <p className="px-2 py-2 text-xs text-muted-foreground">Lista cortada (muitos arquivos).</p> : null}
      </div>
      <div className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
        {entries.filter((e) => e.type === "file").length} arquivos
      </div>
    </aside>
  );

  return (
    <div className="flex h-full min-h-0 flex-1">
      {showList ? treePane : null}
      {showFile ? (
        <main className="min-w-0 flex-1">
          {selected === "" ? (
            <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
              Escolha uma nota na árvore, ou crie uma com “+”.
            </div>
          ) : (
            <FileView
              key={`${vault}:${selected}`}
              rpc={rpc}
              vault={vault}
              vaultRoot={current.root}
              path={selected}
              wide={wide}
              readOnly={readOnly}
              onOpenPath={(p) => openPath(p)}
              onBack={compact ? () => openPath("") : null}
              onCopySaved={(p) => {
                refreshTree();
                openPath(p);
              }}
            />
          )}
        </main>
      ) : null}

      {menu !== null ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          node={menu.node}
          onClose={closeMenu}
          onNew={(type) => {
            if (readOnly) return readOnlyNotice();
            const n = menu.node;
            const dir = n === null ? scope : n.type === "dir" ? n.path : parentOf(n.path);
            if (n !== null && n.type === "dir") setExpanded((prev) => new Set(prev).add(n.path));
            setDialog({ kind: "new", type, dir });
          }}
          onRename={() => (readOnly ? readOnlyNotice() : menu.node !== null && setDialog({ kind: "rename", node: menu.node }))}
          onTrash={() => (readOnly ? readOnlyNotice() : menu.node !== null && setDialog({ kind: "trash", node: menu.node }))}
        />
      ) : null}
      {dialog?.kind === "new" ? (
        <NameDialog
          title={dialog.type === "file" ? "Nova nota" : "Nova pasta"}
          description={`Será criada em “${dialog.dir === "" ? "/" : dialog.dir}”. Use “/” no nome para criar subpastas.${dialog.type === "file" ? " Sem extensão, vira .md." : ""}`}
          initial=""
          confirmLabel="Criar"
          onClose={() => setDialog(null)}
          onSubmit={async (value) => {
            let name = value;
            if (dialog.type === "file" && !/\.[A-Za-z0-9]+$/.test(name)) name += ".md";
            const path = joinPath(dialog.dir, name);
            const stem = baseName(name).replace(/\.[^.]+$/, "");
            await rpc.call("create", {
              vault,
              path,
              type: dialog.type,
              content: dialog.type === "file" && /\.(md|markdown|mdx)$/i.test(name) ? `# ${stem}\n\n` : "",
            });
            refreshTree();
            if (dialog.type === "file") openPath(path);
            else setExpanded((p) => new Set(p).add(path));
          }}
        />
      ) : null}
      {dialog?.kind === "rename" ? (
        <NameDialog
          title="Renomear ou mover"
          description="Edite o nome, ou o caminho completo para mover (ex.: Projetos/ideia.md). Nunca sobrescreve um item existente."
          initial={dialog.node.path}
          confirmLabel="Salvar"
          onClose={() => setDialog(null)}
          onSubmit={async (value) => {
            const to = value.replace(/^\/+/, "");
            await rpc.call("rename", { vault, from: dialog.node.path, to });
            if (selected === dialog.node.path) openPath(to, true);
            refreshTree();
          }}
        />
      ) : null}
      {dialog?.kind === "trash" ? (
        <TrashConfirm
          node={dialog.node}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            try {
              await rpc.call("trash", { vault, path: dialog.node.path, confirm: true });
              toast.success(`“${dialog.node.name}” foi para a lixeira.`);
              if (selected === dialog.node.path || selected.startsWith(`${dialog.node.path}/`)) openPath("", true);
              refreshTree();
            } catch (e) {
              toast.error(msg(e));
            }
          }}
        />
      ) : null}
      {dialog?.kind === "lixeira" ? (
        <TrashDialog rpc={rpc} vault={vault} onClose={() => setDialog(null)} onRestored={() => refreshTree()} />
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "notes",
    title: "Notes",
    icon: "FileText",
    path: "notes",
    component: NotesPage,
  });
});

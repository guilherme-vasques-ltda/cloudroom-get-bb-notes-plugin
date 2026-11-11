// Editor visual (WYSIWYG) de Markdown, baseado no editor do plugin Docs do get-bb/bb (MIT, ver NOTICE.md).
// Você edita o texto já formatado; ao salvar, blocos que você NÃO tocou voltam byte a byte
// iguais ao arquivo original (lib/markdown-blocks.ts) e o cabeçalho YAML é preservado.
import { useEffect, useRef, useState } from "react";
import { Editor, Extension, InputRule } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import StarterKit from "@tiptap/starter-kit";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Markdown } from "tiptap-markdown";
import { MarkdownTable, TightTaskList } from "../lib/editor-extensions";
import { isAllowedLink } from "../lib/link-policy";
import { parseMarkdownDocument } from "../lib/frontmatter";
import { loadMarkdownBlocks, saveMarkdownBlocks, type MarkdownBlocks } from "../lib/markdown-blocks";
import { HtmlBlock, HtmlSource } from "../lib/raw-html";

const MarkdownTaskInput = Extension.create({
  name: "markdownTaskInput",
  priority: 200,
  addInputRules() {
    return [
      new InputRule({
        find: /^\s*\[([ xX]?)\]\s$/,
        handler: ({ range, match, chain }) => {
          const commands = chain().deleteRange(range).toggleTaskList();
          if (/[xX]/.test(match[1] ?? "")) commands.updateAttributes("taskItem", { checked: true });
          commands.run();
        },
      }),
    ];
  },
});

/** Imagem cujo arquivo é buscado pelo servidor (data URL); o Markdown guarda o caminho relativo. */
const NoteImage = Image.extend<{ resolve: ((src: string) => Promise<string | null>) | null }>({
  addOptions() {
    return { ...this.parent?.(), resolve: null };
  },
  addNodeView() {
    const resolve = this.options.resolve;
    return ({ node }) => {
      const img = document.createElement("img");
      img.alt = String(node.attrs.alt ?? "");
      const src = String(node.attrs.src ?? "");
      if (/^data:image\//.test(src)) img.src = src;
      else if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) {
        img.alt = img.alt || "imagem externa bloqueada (sem rede)";
        img.setAttribute("data-blocked", "");
      } else if (resolve !== null) {
        void resolve(src).then((url) => {
          if (url !== null) img.src = url;
          else img.alt = `imagem não encontrada: ${src}`;
        });
      }
      return {
        dom: img,
        update: (next) => next.type === node.type && next.attrs.src === node.attrs.src && next.attrs.alt === node.attrs.alt,
      };
    };
  },
});

const STYLE_MARKER = "data-notes-editor-styles";
const EDITOR_CSS = `
.nt-editor .tiptap{outline:none;width:100%;max-width:50em;margin:0 auto;padding:2rem 1.75rem 40vh;font-size:15px;line-height:1.75;color:var(--foreground);caret-color:var(--foreground);overflow-wrap:break-word}
.nt-editor .tiptap>:first-child,.nt-editor .tiptap li>:first-child,.nt-editor .tiptap blockquote>:first-child{margin-top:0}
.nt-editor .tiptap p{margin:1em 0 0}
.nt-editor .tiptap h1,.nt-editor .tiptap h2,.nt-editor .tiptap h3,.nt-editor .tiptap h4,.nt-editor .tiptap h5,.nt-editor .tiptap h6{margin-bottom:0;font-weight:600;color:var(--foreground)}
.nt-editor .tiptap h1{font-size:1.75em;line-height:1.3;margin-top:1.25em}
.nt-editor .tiptap h2{font-size:1.35em;line-height:1.4;margin-top:1.6em}
.nt-editor .tiptap h3{font-size:1.125em;line-height:1.45;margin-top:1.25em}
.nt-editor .tiptap h4,.nt-editor .tiptap h5,.nt-editor .tiptap h6{font-size:1em;margin-top:1.1em}
.nt-editor .tiptap ul,.nt-editor .tiptap ol{margin:1em 0 0;padding-left:1.5em}
.nt-editor .tiptap ul{list-style:disc}.nt-editor .tiptap ol{list-style:decimal}
.nt-editor .tiptap li{margin-top:.4em;padding-left:.3em}
.nt-editor .tiptap li>p,.nt-editor .tiptap li>ul,.nt-editor .tiptap li>ol{margin-top:.4em}
.nt-editor .tiptap li::marker{color:var(--muted-foreground)}
.nt-editor .tiptap a{color:inherit;font-weight:500;text-decoration:underline;text-decoration-color:color-mix(in oklab,currentColor 35%,transparent);cursor:text}
.nt-editor .tiptap strong{font-weight:650}
.nt-editor .tiptap code{background:var(--muted);border-radius:.35em;padding:.125em .3em;font-size:.85em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.nt-editor .tiptap pre{background:var(--muted);border-radius:var(--radius);padding:.75em 1em;overflow-x:auto;font-size:.875em;line-height:1.5;margin:1.2em 0 0}
.nt-editor .tiptap pre code{background:none;padding:0;font-size:inherit}
.nt-editor .tiptap pre[data-html-block]{background:none;padding:0;border-radius:0;font:inherit;white-space:pre-wrap;opacity:.8}
.nt-editor .tiptap blockquote{border-left:3px solid var(--border);padding-left:1em;margin:1em 0 0;opacity:.9}
.nt-editor .tiptap hr{border:none;border-top:1px solid var(--border);margin:2em 0 0}
.nt-editor .tiptap img{display:block;max-width:100%;max-height:38rem;margin:1.2em auto 0;border-radius:var(--radius);border:1px solid var(--border)}
.nt-editor .tiptap img[data-blocked]{display:inline-block;min-width:3em;padding:2px 6px;border-style:dashed;font-size:.8em}
.nt-editor .tiptap .tableWrapper{margin:1.2em 0 0;overflow-x:auto}
.nt-editor .tiptap table{width:100%;border-collapse:collapse;table-layout:fixed}
.nt-editor .tiptap th,.nt-editor .tiptap td{position:relative;min-width:6rem;border:1px solid var(--border);padding:.45em .65em;text-align:left;vertical-align:top}
.nt-editor .tiptap th{background:var(--muted);font-weight:600}
.nt-editor .tiptap :is(th,td)>p{margin-top:0}
.nt-editor .tiptap .selectedCell::after{position:absolute;inset:0;z-index:2;pointer-events:none;content:"";background:color-mix(in oklab,var(--primary) 14%,transparent)}
.nt-editor .tiptap .column-resize-handle{position:absolute;top:0;right:-2px;bottom:-1px;width:4px;z-index:3;pointer-events:none;background:var(--primary)}
.nt-editor .tiptap ul[data-type="taskList"]{list-style:none;padding-left:.25em}
.nt-editor .tiptap ul[data-type="taskList"] li{display:flex;align-items:flex-start;gap:.5em;margin-top:.4em;padding-left:0}
.nt-editor .tiptap ul[data-type="taskList"] li>label{flex:0 0 auto;display:inline-flex;align-items:center;height:1.7em;user-select:none}
.nt-editor .tiptap ul[data-type="taskList"] li>div{flex:1 1 auto;min-width:0}
.nt-editor .tiptap ul[data-type="taskList"] li>div>p:first-child{margin-top:0}
.nt-editor .tiptap ul[data-type="taskList"] input[type=checkbox]{width:15px;height:15px;accent-color:var(--primary);cursor:pointer;margin:0}
.nt-editor .tiptap ul[data-type="taskList"] li[data-checked="true"]>div{color:var(--muted-foreground);text-decoration:line-through}
.nt-editor .tiptap p.is-editor-empty:first-child::before{content:attr(data-placeholder);float:left;height:0;pointer-events:none;color:var(--muted-foreground)}
.nt-front{font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;padding:.6em .8em;border-radius:8px;background:var(--muted);max-width:50em;margin:1rem auto 0;color:var(--muted-foreground)}
`;
function ensureEditorStyles() {
  const existing = document.head.querySelector<HTMLStyleElement>(`[${STYLE_MARKER}]`);
  if (existing !== null) {
    existing.textContent = EDITOR_CSS;
    return;
  }
  const style = document.createElement("style");
  style.setAttribute(STYLE_MARKER, "");
  style.textContent = EDITOR_CSS;
  document.head.append(style);
}

export type VisualHandle = {
  editor: Editor;
  pickImage: () => void;
};

export function VisualEditor(props: {
  value: string;
  onMarkdownChange: (markdown: string) => void;
  resolveImage: (src: string) => Promise<string | null>;
  uploadImage: (file: File) => Promise<string>;
  onOpenLink: (href: string) => void;
  onReady: (editor: Editor | null) => void;
  disabled?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const blocksRef = useRef<MarkdownBlocks | null>(null);
  const sourceRef = useRef(props.value);
  const serializeRef = useRef<() => string>(() => "");
  const serializeBlockRef = useRef<(nodes: ProseMirrorNode[]) => string>(() => "");
  const latest = useRef(props);
  latest.current = props;
  const [front, setFront] = useState(parseMarkdownDocument(props.value).frontmatter);
  const display = (s: string) => s;

  useEffect(() => {
    ensureEditorStyles();
    const root = rootRef.current;
    if (root === null) return;
    sourceRef.current = latest.current.value;
    const doc = parseMarkdownDocument(sourceRef.current);
    setFront(doc.frontmatter);
    const upload = async (file: File) => {
      if (!file.type.startsWith("image/")) return false;
      try {
        const rel = await latest.current.uploadImage(file);
        editor.chain().focus().setImage({ src: rel, alt: file.name }).run();
      } catch {
        /* o chamador já mostrou o erro */
      }
      return true;
    };
    const editor: Editor = new Editor({
      element: root,
      extensions: [
        StarterKit,
        Link.configure({
          openOnClick: false,
          autolink: true,
          // Links relativos de notas (Orion/plano.md, ../x.md) e esquemas como obsidian:// ou file://
          // precisam sobreviver à edição: aceita tudo que o validador padrão aceita e todo caminho relativo.
          isAllowedUri: (url, ctx) => isAllowedLink(url, ctx.defaultValidate),
        }),
        NoteImage.configure({ resolve: (s: string) => latest.current.resolveImage(s) }),
        TightTaskList,
        TaskItem.configure({ nested: true }),
        MarkdownTable.configure({ resizable: true, lastColumnResizable: false }),
        TableRow,
        TableHeader,
        TableCell,
        MarkdownTaskInput,
        HtmlBlock,
        HtmlSource,
        Placeholder.configure({ placeholder: "Comece a escrever…" }),
        Markdown.configure({ html: true, tightLists: true, bulletListMarker: "-", linkify: true }),
      ],
      content: "",
      editable: !latest.current.disabled,
      editorProps: {
        attributes: { role: "textbox", "aria-label": "Conteúdo da nota", "aria-multiline": "true" },
        handleClick(_view, _pos, event) {
          const a = (event.target as HTMLElement).closest("a");
          if (a !== null && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            latest.current.onOpenLink(a.getAttribute("href") ?? "");
            return true;
          }
          return false;
        },
        handlePaste(_v, event) {
          const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
          if (file === undefined) return false;
          void upload(file);
          return true;
        },
        handleDrop(_v, event) {
          const file = [...(event.dataTransfer?.files ?? [])].find((f) => f.type.startsWith("image/"));
          if (file === undefined) return false;
          event.preventDefault();
          void upload(file);
          return true;
        },
      },
    });
    editorRef.current = editor;
    blocksRef.current = loadMarkdownBlocks(editor, doc.body, display, false);
    const serializeNodes = (nodes: ProseMirrorNode[]) =>
      editor.storage.markdown.serializer.serialize(editor.schema.topNodeType.create(null, nodes)) as string;
    const getMarkdown = () =>
      parseMarkdownDocument(sourceRef.current).frontmatter + saveMarkdownBlocks(editor, blocksRef.current!, serializeNodes);
    serializeRef.current = getMarkdown;
    serializeBlockRef.current = serializeNodes;
    // só reage a edição do usuário (não a carregamentos), então abrir um arquivo nunca o reescreve
    editor.on("update", () => latest.current.onMarkdownChange(getMarkdown()));
    latest.current.onReady(editor);
    return () => {
      latest.current.onReady(null);
      editor.destroy();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // O arquivo mudou por fora (ou "pegar o deles"): recarrega preservando os blocos iguais.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor === null) return;
    if (props.value !== sourceRef.current && props.value !== serializeRef.current()) {
      const doc = parseMarkdownDocument(props.value);
      blocksRef.current = loadMarkdownBlocks(editor, doc.body, display, false, blocksRef.current && {
        loaded: blocksRef.current,
        serialize: serializeBlockRef.current,
        refreshMedia: false,
      });
      setFront(doc.frontmatter);
    }
    sourceRef.current = props.value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);

  useEffect(() => {
    editorRef.current?.setEditable(!props.disabled, false);
  }, [props.disabled]);

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      {front.replace(/\uFEFF/g, "").trim() === "" ? null : <pre className="nt-front" title="Cabeçalho (YAML): fica como está; edite no modo Markdown">{front.trim()}</pre>}
      <div ref={rootRef} className="nt-editor text-sm" />
    </div>
  );
}

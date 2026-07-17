/**
 * MarkdownEditor — plain CodeMirror markdown editor with syntax highlighting.
 *
 * Shows raw markdown with light syntax coloring. The preview tab (in
 * NoteEditor) handles rich rendering — keeping the editor simple and
 * predictable, especially for tables and complex markdown.
 *
 * Uses the app's CSS variables for seamless light/dark mode support.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";
import {
  htmlToMarkdown,
  getClipboardImageBlob,
  blobToBase64,
  type RichPasteOptions,
} from "../services/richPaste";
import { invoke } from "../services/tauri";
import { useAppStore, type ActivityEntry } from "../stores/appStore";

const RICH_PASTE_CONFIG_TIMEOUT_MS = 5_000;

interface MarkdownContextMenuState {
  x: number;
  y: number;
}

interface MarkdownContextMenuDetail {
  editorId: string;
  x: number;
  y: number;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

/** Editor chrome theme — cursor, selection, gutters, layout. */
const editorTheme = EditorView.theme({
  "&": {
    fontSize: "0.85rem",
    fontFamily: '"Geist Mono", "Cascadia Code", "Fira Code", ui-monospace, monospace',
    backgroundColor: "transparent",
    color: "rgb(var(--color-text))",
  },
  ".cm-content": {
    padding: "1.5rem 0",
    caretColor: "rgb(var(--color-accent))",
    lineHeight: "1.75",
  },
  ".cm-line": {
    padding: "2px 0",
  },
  ".cm-cursor": { borderLeftColor: "rgb(var(--color-accent))" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, rgb(var(--color-text)) 4%, transparent)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, rgb(var(--color-accent)) 18%, transparent) !important",
  },
  ".cm-gutters": { display: "none" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "auto" },
  ".cm-placeholder": {
    color: "rgb(var(--color-text-secondary))",
    fontStyle: "italic",
  },
});

export interface MarkdownEditorProps {
  /** Initial/controlled value. */
  value: string;
  /** Called on every edit with the new content. */
  onChange: (value: string) => void;
  /** Placeholder text shown when empty. */
  placeholder?: string;
  /** Stable key to force remount (e.g., file path). */
  editorKey?: string;
  /** Whether to save pasted images to project (requires open project). */
  saveImages?: boolean;
  /** Async function that returns fresh AI config (with refreshed token). */
  getAiConfig?: () => Promise<RichPasteOptions["aiConfig"] | undefined>;
}

/**
 * CodeMirror extension: intercept paste events to convert HTML → Markdown.
 * Handles Word documents, web pages, and pasted images.
 */
function richPasteExtension(
  editorId: string,
  saveImages: boolean,
) {
  return EditorView.domEventHandlers({
    contextmenu(event: MouseEvent, view: EditorView) {
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (position !== null) {
        view.dispatch({ selection: { anchor: position } });
      }
      event.preventDefault();
      window.dispatchEvent(new CustomEvent<MarkdownContextMenuDetail>("cutready:markdown-editor-context-menu", {
        detail: {
          editorId,
          x: event.clientX,
          y: event.clientY,
        },
      }));
      return true;
    },
    paste(event: ClipboardEvent, view: EditorView) {
      const clip = event.clipboardData;
      if (!clip) return false;

      // Image paste (screenshots, snipping tool) has no useful plain-text default.
      // HTML-to-Markdown conversion is user-triggered from the context menu.
      const imageBlob = getClipboardImageBlob(clip);
      if (imageBlob && saveImages) {
        event.preventDefault();

        const ext = imageBlob.type.split("/")[1] || "png";
        blobToBase64(imageBlob).then(async (base64) => {
          try {
            const relativePath = await invoke<string>("save_pasted_image", {
              base64Data: base64,
              extension: ext,
            });
            const md = `![](${relativePath})`;
            const { from, to } = view.state.selection.main;
            view.dispatch({
              changes: { from, to, insert: md },
              selection: { anchor: from + md.length },
            });
          } catch (err) {
            console.error("Failed to save pasted image:", err);
          }
        });

        return true;
      }

      // Default: let CodeMirror handle plain text paste
      return false;
    },
  });
}

function insertMarkdown(view: EditorView, markdown: string) {
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: markdown },
    selection: { anchor: from + markdown.length },
  });
}

function clipboardItemType(item: ClipboardItem, mimeType: string) {
  return item.types.find((type) => type.toLowerCase() === mimeType);
}

export function MarkdownEditor({ value, onChange, placeholder, editorKey, saveImages = true, getAiConfig }: MarkdownEditorProps) {
  const editorIdRef = useRef(`markdown-editor-${Math.random().toString(36).slice(2, 10)}`);
  const viewRef = useRef<EditorView | null>(null);
  const [contextMenu, setContextMenu] = useState<MarkdownContextMenuState | null>(null);
  const getAiConfigRef = useRef(getAiConfig);
  getAiConfigRef.current = getAiConfig;

  const addActivityEntries = useAppStore((s) => s.addActivityEntries);
  const addActivityRef = useRef(addActivityEntries);
  addActivityRef.current = addActivityEntries;

  const extensions = useMemo(() => [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    EditorView.lineWrapping,
    editorTheme,
    richPasteExtension(
      editorIdRef.current,
      saveImages,
    ),
  ], [saveImages]);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    const handleContextMenu = (event: Event) => {
      const detail = (event as CustomEvent<MarkdownContextMenuDetail>).detail;
      if (detail?.editorId === editorIdRef.current) {
        setContextMenu({ x: detail.x, y: detail.y });
      } else {
        closeMenu();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("cutready:markdown-editor-context-menu", handleContextMenu);
    window.addEventListener("click", closeMenu);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("cutready:markdown-editor-context-menu", handleContextMenu);
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const logActivity = useCallback((msg: string, level: ActivityEntry["level"]) => {
    addActivityRef.current([{
      id: `paste-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date(),
      source: "Rich Paste",
      content: msg,
      level,
    }]);
  }, []);

  const readClipboardText = useCallback(async () => {
    if (!navigator.clipboard?.readText) {
      throw new Error("Clipboard text access is unavailable");
    }
    return navigator.clipboard.readText();
  }, []);

  const handlePlainPaste = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    setContextMenu(null);
    try {
      const text = await readClipboardText();
      if (text) insertMarkdown(view, text);
    } catch (err) {
      logActivity(`Plain paste failed: ${err}`, "error");
    }
  }, [logActivity, readClipboardText]);

  const handleIntelligentPaste = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    setContextMenu(null);
    window.dispatchEvent(new CustomEvent("cutready:rich-paste-busy", { detail: true }));

    try {
      let html = "";
      let plain = "";
      let image: Blob | null = null;
      let imageExtension = "png";

      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const htmlType = clipboardItemType(item, "text/html");
          if (htmlType && !html) {
            html = await (await item.getType(htmlType)).text();
          }

          const textType = clipboardItemType(item, "text/plain");
          if (textType && !plain) {
            plain = await (await item.getType(textType)).text();
          }

          const imageType = item.types.find((type) => type.startsWith("image/"));
          if (imageType && !image) {
            image = await item.getType(imageType);
            imageExtension = imageType.split("/")[1] || "png";
          }
        }
      } else {
        plain = await readClipboardText();
      }

      if (html) {
        const aiConfig = await withTimeout(
          getAiConfigRef.current?.() ?? Promise.resolve(undefined),
          RICH_PASTE_CONFIG_TIMEOUT_MS,
          "Rich paste AI config",
        ).catch((err) => {
          logActivity(`Rich paste: AI config unavailable — ${err}`, "warn");
          return undefined;
        });
        const { markdown: md } = await htmlToMarkdown(html, {
          saveImages,
          aiConfig,
          onStatus: logActivity,
        });
        insertMarkdown(view, md);
        return;
      }

      if (image && saveImages) {
        const base64 = await blobToBase64(image);
        const relativePath = await invoke<string>("save_pasted_image", {
          base64Data: base64,
          extension: imageExtension,
        });
        insertMarkdown(view, `![](${relativePath})`);
        return;
      }

      if (plain) {
        insertMarkdown(view, plain);
        logActivity("Rich paste: clipboard had no HTML; pasted plain text", "info");
      }
    } catch (err) {
      logActivity(`Rich paste failed: ${err}`, "error");
      try {
        const text = await readClipboardText();
        if (text) insertMarkdown(view, text);
      } catch {
        // The original error already explains why paste failed.
      }
    } finally {
      window.dispatchEvent(new CustomEvent("cutready:rich-paste-busy", { detail: false }));
    }
  }, [logActivity, readClipboardText, saveImages]);

  return (
    <div className="relative">
      <CodeMirror
        key={editorKey}
        value={value}
        extensions={extensions}
        onChange={onChange}
        onCreateEditor={(view) => {
          viewRef.current = view;
        }}
        placeholder={placeholder ?? "Write markdown here..."}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: true,
          highlightSelectionMatches: true,
          bracketMatching: false,
          closeBrackets: false,
          autocompletion: false,
          indentOnInput: true,
          syntaxHighlighting: false,
        }}
        theme="none"
      />
      {contextMenu && (
        <div
          className="fixed z-50 min-w-48 overflow-hidden rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] py-1 text-sm shadow-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="block w-full px-3 py-2 text-left text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))]"
            onClick={handleIntelligentPaste}
          >
            Paste intelligently
          </button>
          <button
            type="button"
            role="menuitem"
            className="block w-full px-3 py-2 text-left text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))]"
            onClick={handlePlainPaste}
          >
            Paste plain text
          </button>
        </div>
      )}
    </div>
  );
}

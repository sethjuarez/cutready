/**
 * MarkdownEditor — plain CodeMirror markdown editor with syntax highlighting.
 *
 * Shows raw markdown with light syntax coloring. The preview tab (in
 * NoteEditor) handles rich rendering — keeping the editor simple and
 * predictable, especially for tables and complex markdown.
 *
 * Uses the app's CSS variables for seamless light/dark mode support.
 */
import { useMemo, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";
import {
  clipboardHasHtml,
  htmlToMarkdown,
  getClipboardImageBlob,
  blobToBase64,
  type RichPasteOptions,
} from "../services/richPaste";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, type ActivityEntry } from "../stores/appStore";

const RICH_PASTE_CONFIG_TIMEOUT_MS = 5_000;

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
  saveImages: boolean,
  getAiConfig: () => Promise<RichPasteOptions["aiConfig"] | undefined>,
  logActivity: (msg: string, level: ActivityEntry["level"]) => void,
) {
  return EditorView.domEventHandlers({
    paste(event: ClipboardEvent, view: EditorView) {
      const clip = event.clipboardData;
      if (!clip) return false;

      // Case 1: HTML content (Word, web pages, rich text apps)
      if (clipboardHasHtml(clip)) {
        const html = clip.getData("text/html");
        if (!html) return false;

        // Prevent default paste — we'll insert our own content
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("cutready:rich-paste-busy", { detail: true }));

        // Get fresh AI config (with refreshed token) then convert
        withTimeout(getAiConfig(), RICH_PASTE_CONFIG_TIMEOUT_MS, "Rich paste AI config").catch((err) => {
          logActivity(`Rich paste: AI config unavailable — ${err}`, "warn");
          return undefined;
        }).then((aiConfig) =>
          htmlToMarkdown(html, {
            saveImages,
            aiConfig,
            onStatus: logActivity,
          })
        ).then(({ markdown: md }) => {
          const { from, to } = view.state.selection.main;
          view.dispatch({
            changes: { from, to, insert: md },
            selection: { anchor: from + md.length },
          });
        }).catch((err) => {
          logActivity(`Rich paste failed: ${err}`, "error");
          // Fallback: insert plain text
          const plain = clip.getData("text/plain");
          if (plain) {
            const { from, to } = view.state.selection.main;
            view.dispatch({
              changes: { from, to, insert: plain },
              selection: { anchor: from + plain.length },
            });
          }
        }).finally(() => {
          window.dispatchEvent(new CustomEvent("cutready:rich-paste-busy", { detail: false }));
        });

        return true;
      }

      // Case 2: Image paste (screenshots, snipping tool)
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

export function MarkdownEditor({ value, onChange, placeholder, editorKey, saveImages = true, getAiConfig }: MarkdownEditorProps) {
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
      saveImages,
      async () => getAiConfigRef.current?.(),
      (msg, level) => {
        addActivityRef.current([{
          id: `paste-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: new Date(),
          source: "Rich Paste",
          content: msg,
          level,
        }]);
      },
    ),
  ], [saveImages]);

  return (
    <CodeMirror
      key={editorKey}
      value={value}
      extensions={extensions}
      onChange={onChange}
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
  );
}


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

/** Editor chrome theme — cursor, selection, gutters, layout. */
const editorTheme = EditorView.theme({
  "&": {
    fontSize: "0.85rem",
    fontFamily: '"Geist Mono", "Cascadia Code", "Fira Code", ui-monospace, monospace',
    backgroundColor: "transparent",
    color: "var(--color-text)",
  },
  ".cm-content": {
    padding: "1.5rem 0",
    caretColor: "var(--color-accent)",
    lineHeight: "1.75",
  },
  ".cm-line": {
    padding: "2px 0",
  },
  ".cm-cursor": { borderLeftColor: "var(--color-accent)" },
  ".cm-activeLine": { backgroundColor: "var(--color-surface-alt)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--color-accent) !important",
    opacity: "0.15",
  },
  ".cm-gutters": { display: "none" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "auto" },
  ".cm-placeholder": {
    color: "var(--color-text-secondary)",
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
  /** AI config for smart paste refinement (pass from useSettings). */
  aiConfig?: RichPasteOptions["aiConfig"];
}

/**
 * CodeMirror extension: intercept paste events to convert HTML → Markdown.
 * Handles Word documents, web pages, and pasted images.
 */
function richPasteExtension(saveImages: boolean, getAiConfig: () => RichPasteOptions["aiConfig"]) {
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

        // Convert async — insert placeholder then replace
        const aiConfig = getAiConfig();
        htmlToMarkdown(html, { saveImages, aiConfig }).then(({ markdown: md }) => {
          const { from, to } = view.state.selection.main;
          view.dispatch({
            changes: { from, to, insert: md },
            selection: { anchor: from + md.length },
          });
        }).catch((err) => {
          console.error("Rich paste failed, falling back to plain text:", err);
          // Fallback: insert plain text
          const plain = clip.getData("text/plain");
          if (plain) {
            const { from, to } = view.state.selection.main;
            view.dispatch({
              changes: { from, to, insert: plain },
              selection: { anchor: from + plain.length },
            });
          }
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

export function MarkdownEditor({ value, onChange, placeholder, editorKey, saveImages = true, aiConfig }: MarkdownEditorProps) {
  const aiConfigRef = useRef(aiConfig);
  aiConfigRef.current = aiConfig;

  const extensions = useMemo(() => [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    EditorView.lineWrapping,
    editorTheme,
    richPasteExtension(saveImages, () => aiConfigRef.current),
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


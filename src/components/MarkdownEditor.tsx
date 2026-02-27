/**
 * MarkdownEditor — reusable inline-styled CodeMirror markdown editor.
 *
 * Renders markdown visually as you type: headers appear larger, bold is bold,
 * code gets backgrounds, blockquotes get accent borders — while keeping raw
 * markdown syntax visible (Typora-like experience).
 *
 * Uses the app's CSS variables for seamless light/dark mode support.
 */
import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";

/** CodeMirror theme matching app CSS variables with inline markdown styling. */
const cutreadyTheme = EditorView.theme({
  "&": {
    fontSize: "0.9rem",
    fontFamily: '"Geist Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    backgroundColor: "transparent",
    color: "var(--color-text)",
  },
  ".cm-content": {
    padding: "1.5rem 0",
    caretColor: "var(--color-accent)",
    lineHeight: "1.7",
  },
  ".cm-cursor": { borderLeftColor: "var(--color-accent)" },
  ".cm-activeLine": { backgroundColor: "var(--color-surface-alt)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--color-accent) !important",
    opacity: "0.15",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    borderRight: "none",
    color: "var(--color-text-secondary)",
    fontSize: "0.75rem",
    minWidth: "3rem",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--color-surface-alt)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "auto" },
  // Markdown inline styles
  ".cm-header-1": { fontSize: "1.5rem", fontWeight: "600", lineHeight: "2" },
  ".cm-header-2": { fontSize: "1.3rem", fontWeight: "600", lineHeight: "1.9" },
  ".cm-header-3": { fontSize: "1.15rem", fontWeight: "600", lineHeight: "1.8" },
  ".cm-header-4": { fontSize: "1.05rem", fontWeight: "600" },
  ".cm-header-5": { fontSize: "1rem", fontWeight: "600" },
  ".cm-header-6": { fontSize: "0.95rem", fontWeight: "600" },
  ".cm-strong": { fontWeight: "600" },
  ".cm-emphasis": { fontStyle: "italic" },
  ".cm-strikethrough": { textDecoration: "line-through" },
  ".cm-link": { color: "var(--color-accent)", textDecoration: "underline" },
  ".cm-url": { color: "var(--color-text-secondary)" },
  // Inline code
  ".cm-monospace": {
    fontFamily: '"Geist Mono", "Cascadia Code", "Fira Code", ui-monospace, monospace',
    fontSize: "0.825rem",
    backgroundColor: "var(--color-surface-alt)",
    padding: "0.1rem 0.3rem",
    borderRadius: "0.2rem",
  },
  // Code block lines
  ".cm-codeblock": {
    fontFamily: '"Geist Mono", "Cascadia Code", "Fira Code", ui-monospace, monospace',
    fontSize: "0.825rem",
    backgroundColor: "var(--color-surface-inset)",
  },
  // Blockquote
  ".cm-quote": {
    color: "var(--color-text-secondary)",
    borderLeft: "3px solid var(--color-accent)",
    paddingLeft: "0.75rem",
  },
  // Meta characters (markdown syntax like #, *, etc.)
  ".cm-meta, .cm-processingInstruction": {
    color: "var(--color-text-secondary)",
  },
  // Horizontal rule
  ".cm-hr": {
    color: "var(--color-border)",
  },
}, { dark: false });

export interface MarkdownEditorProps {
  /** Initial/controlled value. */
  value: string;
  /** Called on every edit with the new content. */
  onChange: (value: string) => void;
  /** Placeholder text shown when empty. */
  placeholder?: string;
  /** Stable key to force remount (e.g., file path). */
  editorKey?: string;
}

export function MarkdownEditor({ value, onChange, placeholder, editorKey }: MarkdownEditorProps) {
  const extensions = useMemo(() => [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    EditorView.lineWrapping,
    cutreadyTheme,
  ], []);

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
      }}
      theme="none"
    />
  );
}

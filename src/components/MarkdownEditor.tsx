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
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/** Syntax highlighting style — applies inline styling to markdown tokens. */
const markdownHighlightStyle = HighlightStyle.define([
  // Headings
  { tag: tags.heading1, fontSize: "1.5em", fontWeight: "700", lineHeight: "1.3" },
  { tag: tags.heading2, fontSize: "1.3em", fontWeight: "600", lineHeight: "1.35" },
  { tag: tags.heading3, fontSize: "1.15em", fontWeight: "600", lineHeight: "1.4" },
  { tag: tags.heading4, fontSize: "1.05em", fontWeight: "600" },
  { tag: tags.heading5, fontSize: "1em", fontWeight: "600" },
  { tag: tags.heading6, fontSize: "0.95em", fontWeight: "600" },
  // Inline formatting
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through", color: "var(--color-text-secondary)" },
  // Links
  { tag: tags.link, color: "var(--color-accent)", textDecoration: "underline" },
  { tag: tags.url, color: "var(--color-text-secondary)" },
  // Code
  { tag: tags.monospace, fontFamily: '"Geist Mono", "Cascadia Code", "Fira Code", ui-monospace, monospace', fontSize: "0.85em", color: "var(--color-accent)" },
  // Quotes
  { tag: tags.quote, color: "var(--color-text-secondary)", fontStyle: "italic" },
  // Meta/markup characters (#, *, >, ```, etc.)
  { tag: tags.processingInstruction, color: "var(--color-text-secondary)" },
  { tag: tags.meta, color: "var(--color-text-secondary)" },
  // Content/keywords
  { tag: tags.contentSeparator, color: "var(--color-border)" },
  { tag: tags.labelName, color: "var(--color-accent)" },
]);

/** Editor chrome theme — cursor, selection, gutters, layout. */
const editorTheme = EditorView.theme({
  "&": {
    fontSize: "0.9rem",
    fontFamily: '"Geist Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
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
}

export function MarkdownEditor({ value, onChange, placeholder, editorKey }: MarkdownEditorProps) {
  const extensions = useMemo(() => [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    syntaxHighlighting(markdownHighlightStyle),
    EditorView.lineWrapping,
    editorTheme,
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
        syntaxHighlighting: false,
      }}
      theme="none"
    />
  );
}


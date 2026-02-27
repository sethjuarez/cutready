import { useCallback, useEffect, useMemo, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";
import { useAppStore } from "../stores/appStore";

/** CodeMirror theme that matches app CSS variables + renders markdown inline. */
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
  // Meta characters (markdown syntax like #, *, etc.) — subtle
  ".cm-meta, .cm-processingInstruction": {
    color: "var(--color-text-secondary)",
  },
  // Horizontal rule
  ".cm-hr": {
    color: "var(--color-border)",
  },
}, { dark: false });

/**
 * NoteEditor — inline-styled CodeMirror markdown editor for .md note files.
 * Markdown renders visually as you type (headers are large, bold is bold, etc.)
 * while keeping the raw markdown syntax visible.
 * Debounced auto-save on content changes.
 */
export function NoteEditor() {
  const activeNotePath = useAppStore((s) => s.activeNotePath);
  const activeNoteContent = useAppStore((s) => s.activeNoteContent);
  const updateNote = useAppStore((s) => s.updateNote);

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingContentRef = useRef<string | null>(null);
  const updateNoteRef = useRef(updateNote);
  updateNoteRef.current = updateNote;

  const extensions = useMemo(() => [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    EditorView.lineWrapping,
    cutreadyTheme,
  ], []);

  const handleChange = useCallback(
    (value: string) => {
      pendingContentRef.current = value;
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        pendingContentRef.current = null;
        updateNoteRef.current(value);
      }, 800);
    },
    [],
  );

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        if (pendingContentRef.current !== null) {
          updateNoteRef.current(pendingContentRef.current);
        }
      }
    };
  }, []);

  if (!activeNotePath) return null;

  const displayTitle = activeNotePath.replace(/\.md$/, "").split("/").pop() ?? activeNotePath;

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Title bar */}
      <div className="flex items-center gap-2 px-6 py-3 border-b border-[var(--color-border)] shrink-0">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--color-text-secondary)] shrink-0">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
        <h1 className="text-lg font-semibold text-[var(--color-text)]">{displayTitle}</h1>
        <span className="text-[10px] text-[var(--color-text-secondary)] px-1.5 py-0.5 rounded bg-[var(--color-surface-alt)]">.md</span>
      </div>

      {/* CodeMirror editor */}
      <div className="flex-1 overflow-auto px-6">
        <div className="max-w-3xl mx-auto">
          <CodeMirror
            key={activeNotePath}
            value={activeNoteContent ?? ""}
            extensions={extensions}
            onChange={handleChange}
            placeholder="Write your notes here... (Markdown renders inline as you type)"
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
        </div>
      </div>
    </div>
  );
}

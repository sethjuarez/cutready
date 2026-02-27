import { useCallback, useEffect, useRef } from "react";
import { useAppStore } from "../stores/appStore";
import { MarkdownEditor } from "./MarkdownEditor";

/**
 * NoteEditor — edits .md note files using the reusable MarkdownEditor.
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

      {/* Markdown editor */}
      <div className="flex-1 overflow-auto px-6">
        <div className="max-w-3xl mx-auto">
          <MarkdownEditor
            editorKey={activeNotePath}
            value={activeNoteContent ?? ""}
            onChange={handleChange}
            placeholder="Write your notes here... (Markdown renders inline as you type)"
          />
        </div>
      </div>
    </div>
  );
}

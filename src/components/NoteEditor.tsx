import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../stores/appStore";

/**
 * NoteEditor — simple markdown textarea editor for .md note files.
 * Debounced auto-save on content changes.
 */
export function NoteEditor() {
  const activeNotePath = useAppStore((s) => s.activeNotePath);
  const activeNoteContent = useAppStore((s) => s.activeNoteContent);
  const updateNote = useAppStore((s) => s.updateNote);

  const [localContent, setLocalContent] = useState(activeNoteContent ?? "");
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingContentRef = useRef<string | null>(null);

  // Reset when switching notes
  useEffect(() => {
    setLocalContent(activeNoteContent ?? "");
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    pendingContentRef.current = null;
  }, [activeNotePath, activeNoteContent]);

  const handleChange = useCallback(
    (value: string) => {
      setLocalContent(value);
      pendingContentRef.current = value;
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        pendingContentRef.current = null;
        updateNote(value);
      }, 800);
    },
    [updateNote],
  );

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        if (pendingContentRef.current !== null) {
          updateNote(pendingContentRef.current);
        }
      }
    };
  }, [updateNote]);

  if (!activeNotePath) return null;

  const displayTitle = activeNotePath.replace(/\.md$/, "").split("/").pop() ?? activeNotePath;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* Title (read-only, derived from filename) */}
        <div className="flex items-center gap-2 mb-4">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--color-text-secondary)] shrink-0">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
          <h1 className="text-2xl font-semibold text-[var(--color-text)]">{displayTitle}</h1>
          <span className="text-xs text-[var(--color-text-secondary)] ml-auto">.md</span>
        </div>

        {/* Markdown content */}
        <textarea
          value={localContent}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="Write your notes here... (Markdown supported)"
          className="w-full min-h-[calc(100vh-200px)] text-sm bg-transparent text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/40 outline-none border border-[var(--color-border)] rounded-lg px-4 py-3 resize-none focus:ring-1 focus:ring-[var(--color-accent)]/40 transition-colors font-mono leading-relaxed"
          spellCheck
        />
      </div>
    </div>
  );
}

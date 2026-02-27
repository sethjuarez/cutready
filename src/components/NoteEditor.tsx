import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { useAppStore } from "../stores/appStore";
import { ResizeHandle } from "./ResizeHandle";

const PREFS_KEY = "cutready:note-editor";

function loadEditorPrefs(): { previewWidth: number } {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { previewWidth: Math.min(800, Math.max(200, parsed.previewWidth ?? 400)) };
    }
  } catch { /* ignore */ }
  return { previewWidth: 400 };
}

function saveEditorPrefs(prefs: { previewWidth: number }) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
}

/**
 * NoteEditor — split-view markdown editor for .md note files.
 * Left: monospace textarea (edit), Right: rendered markdown preview.
 * Debounced auto-save on content changes.
 */
export function NoteEditor() {
  const activeNotePath = useAppStore((s) => s.activeNotePath);
  const activeNoteContent = useAppStore((s) => s.activeNoteContent);
  const updateNote = useAppStore((s) => s.updateNote);

  const [localContent, setLocalContent] = useState(activeNoteContent ?? "");
  const [previewWidth, setPreviewWidth] = useState(loadEditorPrefs().previewWidth);
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

  const handleResize = useCallback((delta: number) => {
    setPreviewWidth((w) => Math.min(800, Math.max(200, w - delta)));
  }, []);

  const handleResizeEnd = useCallback(() => {
    saveEditorPrefs({ previewWidth });
  }, [previewWidth]);

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

      {/* Split editor + preview */}
      <div className="flex flex-1 overflow-hidden">
        {/* Editor pane */}
        <div className="flex-1 min-w-0 overflow-hidden">
          <textarea
            value={localContent}
            onChange={(e) => handleChange(e.target.value)}
            placeholder="Write your notes here... (Markdown)"
            className="w-full h-full text-sm bg-transparent text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/40 outline-none px-5 py-4 resize-none font-mono leading-relaxed"
            spellCheck
          />
        </div>

        {/* Resize handle */}
        <ResizeHandle direction="horizontal" onResize={handleResize} onResizeEnd={handleResizeEnd} />

        {/* Preview pane */}
        <div
          className="shrink-0 overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-surface)]"
          style={{ width: previewWidth }}
        >
          <div className="px-6 py-4 prose-cutready">
            {localContent ? (
              <Markdown>{localContent}</Markdown>
            ) : (
              <p className="text-sm text-[var(--color-text-secondary)] italic">Preview will appear here...</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

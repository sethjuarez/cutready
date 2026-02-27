import { useCallback, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { PlanningRow } from "../types/sketch";

interface SketchPreviewProps {
  rows: PlanningRow[];
  projectRoot: string;
  title: string;
  onClose: () => void;
}

/**
 * Full-screen PowerPoint-style preview of a sketch.
 * Shows one row at a time: screenshot (or placeholder) + narrative/actions.
 * Arrow keys or click to navigate. Escape to close.
 */
export function SketchPreview({ rows, projectRoot, title, onClose }: SketchPreviewProps) {
  const [currentIdx, setCurrentIdx] = useState(0);
  const total = rows.length;
  const row = rows[currentIdx];

  const goPrev = useCallback(() => {
    setCurrentIdx((i) => Math.max(0, i - 1));
  }, []);

  const goNext = useCallback(() => {
    setCurrentIdx((i) => Math.min(total - 1, i + 1));
  }, [total]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " ") {
        e.preventDefault();
        goNext();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "Home") {
        setCurrentIdx(0);
      } else if (e.key === "End") {
        setCurrentIdx(total - 1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, goNext, goPrev, total]);

  if (!row) return null;

  const screenshotSrc = row.screenshot && projectRoot
    ? convertFileSrc(`${projectRoot}/${row.screenshot}`)
    : null;

  return (
    <div className="fixed inset-0 z-[9999] bg-[var(--color-surface)] flex flex-col select-none">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-3 shrink-0 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-[var(--color-text)]">{title}</span>
          <span className="text-xs text-[var(--color-text-secondary)]">
            {currentIdx + 1} / {total}
          </span>
          {row.time && (
            <>
              <div className="w-px h-4 bg-[var(--color-border)]" />
              <span className="text-xs text-[var(--color-text-secondary)]">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="inline -mt-px mr-1">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                {row.time}
              </span>
            </>
          )}
        </div>
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors px-2 py-1 rounded-md hover:bg-[var(--color-surface-alt)]"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
          Close
        </button>
      </div>

      {/* Main content area */}
      <div className="flex-1 flex flex-col items-center justify-center overflow-hidden px-8 py-6 gap-6">
        {/* Screenshot */}
        <div className="flex-1 flex items-center justify-center w-full min-h-0">
          {screenshotSrc ? (
            <img
              src={screenshotSrc}
              alt={`Row ${currentIdx + 1}`}
              className="max-w-full max-h-full object-contain rounded-lg shadow-lg"
            />
          ) : (
            <div className="w-full max-w-2xl aspect-video rounded-lg border-2 border-dashed border-[var(--color-border)] flex items-center justify-center">
              <div className="flex flex-col items-center gap-2 text-[var(--color-text-secondary)]">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="opacity-30">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
                <span className="text-xs">No screenshot</span>
              </div>
            </div>
          )}
        </div>

        {/* Narrative & Actions card */}
        <div className="w-full max-w-3xl shrink-0 max-h-[30vh] overflow-y-auto bg-[var(--color-surface-alt)] rounded-xl border border-[var(--color-border)] px-6 py-4">
          <div className="flex gap-8">
            {/* Narrative */}
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-medium text-[var(--color-text-secondary)] uppercase tracking-wider mb-1">Narrative</div>
              <div className="text-sm text-[var(--color-text)] whitespace-pre-wrap">
                {row.narrative || <span className="text-[var(--color-text-secondary)] italic">No narrative</span>}
              </div>
            </div>
            {/* Actions */}
            {row.demo_actions && (
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-medium text-[var(--color-text-secondary)] uppercase tracking-wider mb-1">Actions</div>
                <div className="text-sm text-[var(--color-text)] whitespace-pre-wrap">{row.demo_actions}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Navigation bar */}
      <div className="flex items-center justify-center gap-4 px-6 py-3 shrink-0 border-t border-[var(--color-border)]">
        <button
          onClick={goPrev}
          disabled={currentIdx === 0}
          className="p-2 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-alt)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="Previous (←)"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>

        {/* Slide dots */}
        <div className="flex items-center gap-1.5">
          {rows.map((_, i) => (
            <button
              key={i}
              onClick={() => setCurrentIdx(i)}
              className={`rounded-full transition-all ${
                i === currentIdx
                  ? "w-6 h-2 bg-[var(--color-accent)]"
                  : "w-2 h-2 bg-[var(--color-text-secondary)]/30 hover:bg-[var(--color-text-secondary)]/60"
              }`}
              title={`Slide ${i + 1}`}
            />
          ))}
        </div>

        <button
          onClick={goNext}
          disabled={currentIdx === total - 1}
          className="p-2 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-alt)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="Next (→)"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}

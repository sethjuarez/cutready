import { useCallback, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ResizeHandle } from "./ResizeHandle";
import type { PlanningRow } from "../types/sketch";

const PREFS_KEY = "cutready:preview";

function loadPrefs(): { panelSide: "left" | "right"; panelWidth: number; panelVisible: boolean } {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        panelSide: parsed.panelSide === "right" ? "right" : "left",
        panelWidth: Math.min(600, Math.max(200, parsed.panelWidth ?? 320)),
        panelVisible: parsed.panelVisible !== false,
      };
    }
  } catch { /* ignore */ }
  return { panelSide: "left", panelWidth: 320, panelVisible: true };
}

function savePrefs(prefs: { panelSide: "left" | "right"; panelWidth: number; panelVisible: boolean }) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
}

/** A slide in the preview — either a title card or a planning row. */
export type PreviewSlide =
  | { type: "title"; heading: string; subtitle: string; context: string }
  | { type: "row"; row: PlanningRow; context: string };

interface SketchPreviewProps {
  rows: PlanningRow[];
  projectRoot: string;
  title: string;
  onClose: () => void;
  /** If provided, these typed slides are used instead of rows. */
  slides?: PreviewSlide[];
}

/**
 * Full-screen PowerPoint-style preview of a sketch.
 * Shows one row at a time: screenshot (or placeholder) + narrative/actions.
 * Arrow keys or click to navigate. Escape to close.
 */
export function SketchPreview({ rows, projectRoot, title, onClose, slides: slidesProp }: SketchPreviewProps) {
  // Build slides from rows if not provided explicitly
  const slides: PreviewSlide[] = slidesProp ?? rows.map((r) => ({ type: "row", row: r, context: title }));
  const [currentIdx, setCurrentIdx] = useState(0);
  const [activeTab, setActiveTab] = useState<"narrative" | "actions">("narrative");
  const [panelSide, setPanelSide] = useState<"left" | "right">(loadPrefs().panelSide);
  const [panelWidth, setPanelWidth] = useState(loadPrefs().panelWidth);
  const [panelVisible, setPanelVisible] = useState(loadPrefs().panelVisible);
  const total = slides.length;
  const slide = slides[currentIdx];

  const goPrev = useCallback(() => {
    setCurrentIdx((i) => Math.max(0, i - 1));
  }, []);

  const goNext = useCallback(() => {
    setCurrentIdx((i) => Math.min(total - 1, i + 1));
  }, [total]);

  const toggleSide = useCallback(() => {
    setPanelSide((s) => {
      const next = s === "left" ? "right" : "left";
      savePrefs({ panelSide: next, panelWidth, panelVisible });
      return next;
    });
  }, [panelWidth, panelVisible]);

  const togglePanel = useCallback(() => {
    setPanelVisible((v) => {
      const next = !v;
      savePrefs({ panelSide, panelWidth, panelVisible: next });
      return next;
    });
  }, [panelSide, panelWidth]);

  const handleResize = useCallback((delta: number) => {
    setPanelWidth((w) => {
      const adjusted = panelSide === "left" ? w + delta : w - delta;
      return Math.min(600, Math.max(200, adjusted));
    });
  }, [panelSide]);

  const handleResizeEnd = useCallback(() => {
    savePrefs({ panelSide, panelWidth, panelVisible });
  }, [panelSide, panelWidth, panelVisible]);

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

  if (!slide) return null;

  const isTitle = slide.type === "title";
  const row = slide.type === "row" ? slide.row : null;
  const contextLabel = slide.context;

  const screenshotSrc = row?.screenshot && projectRoot
    ? convertFileSrc(`${projectRoot}/${row.screenshot}`)
    : null;

  return (
    <div className="fixed inset-0 z-[9999] bg-[var(--color-surface)] flex flex-col select-none">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-3 shrink-0 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-[var(--color-text)]">{contextLabel}</span>
          <span className="text-xs text-[var(--color-text-secondary)]">
            {currentIdx + 1} / {total}
          </span>
          {row?.time && (
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
        <div className="flex items-center gap-1">
          {/* Toggle panel side */}
          <button
            onClick={toggleSide}
            className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors px-2 py-1 rounded-md hover:bg-[var(--color-surface-alt)]"
            title={`Move panel to ${panelSide === "left" ? "right" : "left"}`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              {panelSide === "left" ? (
                <>
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <line x1="15" y1="3" x2="15" y2="21" />
                </>
              ) : (
                <>
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <line x1="9" y1="3" x2="9" y2="21" />
                </>
              )}
            </svg>
          </button>
          {/* Close */}
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
      </div>

      {/* Main content area — side by side */}
      <div className={`flex-1 flex overflow-hidden ${panelSide === "right" ? "flex-row-reverse" : ""}`}>
        {/* Text panel */}
        {panelVisible && (
          <>
            <div className="shrink-0 flex flex-col" style={{ width: panelWidth }}>
              {/* Tabs + hide */}
              <div className="flex shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface-alt)]">
                <button
                  onClick={() => setActiveTab("narrative")}
                  className={`flex-1 px-4 py-3 text-xs font-semibold uppercase tracking-wide transition-colors ${
                    activeTab === "narrative"
                      ? "text-[var(--color-accent)] border-b-2 border-[var(--color-accent)] bg-[var(--color-surface)]"
                      : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                  }`}
                >
                  Narrative
                </button>
                <button
                  onClick={() => setActiveTab("actions")}
                  className={`flex-1 px-4 py-3 text-xs font-semibold uppercase tracking-wide transition-colors ${
                    activeTab === "actions"
                      ? "text-[var(--color-accent)] border-b-2 border-[var(--color-accent)] bg-[var(--color-surface)]"
                      : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                  }`}
                >
                  Actions
                </button>
                <button
                  onClick={togglePanel}
                  className="px-2.5 py-3 text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
                  title="Hide panel"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    {panelSide === "left" ? (
                      <>
                        <polyline points="11 17 6 12 11 7" />
                        <line x1="6" y1="12" x2="18" y2="12" />
                      </>
                    ) : (
                      <>
                        <polyline points="13 17 18 12 13 7" />
                        <line x1="18" y1="12" x2="6" y2="12" />
                      </>
                    )}
                  </svg>
                </button>
              </div>
              {/* Tab content */}
              <div className="flex-1 overflow-y-auto px-5 py-4">
                {isTitle ? (
                  <div className="text-sm text-[var(--color-text-secondary)] italic">Title slide</div>
                ) : activeTab === "narrative" ? (
                  <div className="text-sm text-[var(--color-text)] whitespace-pre-wrap leading-relaxed">
                    {row!.narrative || <span className="text-[var(--color-text-secondary)] italic">No narrative</span>}
                  </div>
                ) : (
                  <div className="text-sm text-[var(--color-text)] whitespace-pre-wrap leading-relaxed">
                    {row!.demo_actions || <span className="text-[var(--color-text-secondary)] italic">No actions</span>}
                  </div>
                )}
              </div>
            </div>

            {/* Resize handle */}
            <ResizeHandle direction="horizontal" onResize={handleResize} onResizeEnd={handleResizeEnd} />
          </>
        )}

        {/* Screenshot */}
        <div className="flex-1 flex items-center justify-center p-8 min-w-0 relative">
          {!panelVisible && (
            <button
              onClick={togglePanel}
              className={`absolute top-4 ${panelSide === "left" ? "left-4" : "right-4"} p-2 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text)] bg-[var(--color-surface-alt)] hover:bg-[var(--color-surface-inset)] border border-[var(--color-border)] transition-colors`}
              title="Show panel"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                {panelSide === "left" ? (
                  <>
                    <polyline points="13 7 18 12 13 17" />
                    <line x1="18" y1="12" x2="6" y2="12" />
                  </>
                ) : (
                  <>
                    <polyline points="11 7 6 12 11 17" />
                    <line x1="6" y1="12" x2="18" y2="12" />
                  </>
                )}
              </svg>
            </button>
          )}
          {isTitle ? (
            /* Title slide — centered heading + subtitle */
            <div className="flex flex-col items-center justify-center text-center gap-4 max-w-2xl">
              <h1 className="text-4xl font-bold text-[var(--color-text)]">{slide.heading}</h1>
              {slide.subtitle && (
                <p className="text-lg text-[var(--color-text-secondary)] whitespace-pre-wrap leading-relaxed">{slide.subtitle}</p>
              )}
            </div>
          ) : screenshotSrc ? (
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
          {slides.map((s, i) => (
            <button
              key={i}
              onClick={() => setCurrentIdx(i)}
              className={`rounded-full transition-all ${
                i === currentIdx
                  ? "w-6 h-2 bg-[var(--color-accent)]"
                  : s.type === "title"
                    ? "w-2.5 h-2.5 bg-[var(--color-text-secondary)]/40 hover:bg-[var(--color-text-secondary)]/60"
                    : "w-2 h-2 bg-[var(--color-text-secondary)]/30 hover:bg-[var(--color-text-secondary)]/60"
              }`}
              title={s.type === "title" ? (s as any).heading : `Slide ${i + 1}`}
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

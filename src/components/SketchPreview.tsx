import { useCallback, useEffect, useState, useRef, lazy, Suspense } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { SafeMarkdown } from "./SafeMarkdown";
import { ClockIcon, ArrowPathIcon, Squares2X2Icon, XMarkIcon, ArrowLeftIcon, ArrowRightIcon, PhotoIcon, ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { ResizeHandle } from "./ResizeHandle";
import type { PlanningRow } from "../types/sketch";
import type { VisualControlHandle } from "./VisualCell";

const VisualCell = lazy(() => import("./VisualCell"));

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
  const visualControlRef = useRef<VisualControlHandle | null>(null);
  const [visualPlaying, setVisualPlaying] = useState(false);
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

  // Reset visual playing state when slide changes
  useEffect(() => {
    setVisualPlaying(false);
  }, [currentIdx]);

  if (!slide) return null;

  const isTitle = slide.type === "title";
  const row = slide.type === "row" ? slide.row : null;
  const contextLabel = slide.context;
  const hasVisual = !!(row?.visual);

  const screenshotSrc = row?.screenshot && projectRoot
    ? convertFileSrc(`${projectRoot}/${row.screenshot}`)
    : null;

  return (
    <div className="fixed inset-0 z-modal bg-[rgb(var(--color-surface))] flex flex-col select-none">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-3 shrink-0 border-b border-[rgb(var(--color-border))]">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-[rgb(var(--color-text))]">{contextLabel}</span>
          <span className="text-xs text-[rgb(var(--color-text-secondary))]">
            {currentIdx + 1} / {total}
          </span>
          {row?.time && (
            <>
              <div className="w-px h-4 bg-[rgb(var(--color-border))]" />
              <span className="text-xs text-[rgb(var(--color-text-secondary))]">
                <ClockIcon className="w-3 h-3 inline -mt-px mr-1" />
                {row.time}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Replay visual button — shown when current slide has a visual */}
          {hasVisual && !visualPlaying && (
            <button
              onClick={() => visualControlRef.current?.replay()}
              className="flex items-center gap-1.5 text-xs text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] transition-colors px-2 py-1 rounded-md hover:bg-[rgb(var(--color-surface-alt))]"
              title="Replay animation"
            >
              <ArrowPathIcon className="w-3.5 h-3.5" />
              Replay
            </button>
          )}
          {hasVisual && !visualPlaying && (
            <div className="w-px h-4 bg-[rgb(var(--color-border))]" />
          )}
          {/* Toggle panel side */}
          <button
            onClick={toggleSide}
            className="flex items-center gap-1.5 text-xs text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors px-2 py-1 rounded-md hover:bg-[rgb(var(--color-surface-alt))]"
            title={`Move panel to ${panelSide === "left" ? "right" : "left"}`}
          >
            <Squares2X2Icon className="w-3.5 h-3.5" />
          </button>
          {/* Close */}
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 text-xs text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors px-2 py-1 rounded-md hover:bg-[rgb(var(--color-surface-alt))]"
          >
            <XMarkIcon className="w-3.5 h-3.5" />
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
              <div className="flex shrink-0 border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]">
                <button
                  onClick={() => setActiveTab("narrative")}
                  className={`flex-1 px-4 py-3 text-xs font-semibold uppercase tracking-wide transition-colors ${
                    activeTab === "narrative"
                      ? "text-[rgb(var(--color-accent))] border-b-2 border-[rgb(var(--color-accent))] bg-[rgb(var(--color-surface))]"
                      : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
                  }`}
                >
                  Narrative
                </button>
                <button
                  onClick={() => setActiveTab("actions")}
                  className={`flex-1 px-4 py-3 text-xs font-semibold uppercase tracking-wide transition-colors ${
                    activeTab === "actions"
                      ? "text-[rgb(var(--color-accent))] border-b-2 border-[rgb(var(--color-accent))] bg-[rgb(var(--color-surface))]"
                      : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
                  }`}
                >
                  Actions
                </button>
                <button
                  onClick={togglePanel}
                  className="px-2.5 py-3 text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors"
                  title="Hide panel"
                >
                  {panelSide === "left" ? (
                    <ArrowLeftIcon className="w-3.5 h-3.5" />
                  ) : (
                    <ArrowRightIcon className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
              {/* Tab content */}
              <div className="flex-1 overflow-y-auto px-4 py-4">
                {isTitle ? (
                  <div className="text-sm text-[rgb(var(--color-text-secondary))] italic">Title slide</div>
                ) : activeTab === "narrative" ? (
                  row!.narrative ? (
                    <div className="prose-desc text-sm text-[rgb(var(--color-text))] leading-relaxed">
                      <SafeMarkdown>{row!.narrative}</SafeMarkdown>
                    </div>
                  ) : (
                    <span className="text-sm text-[rgb(var(--color-text-secondary))] italic">No narrative</span>
                  )
                ) : (
                  row!.demo_actions ? (
                    <div className="prose-desc text-sm text-[rgb(var(--color-text))] leading-relaxed">
                      <SafeMarkdown>{row!.demo_actions}</SafeMarkdown>
                    </div>
                  ) : (
                    <span className="text-sm text-[rgb(var(--color-text-secondary))] italic">No actions</span>
                  )
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
              className={`absolute top-4 ${panelSide === "left" ? "left-4" : "right-4"} p-2 rounded-lg text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] bg-[rgb(var(--color-surface-alt))] hover:bg-[rgb(var(--color-surface-inset))] border border-[rgb(var(--color-border))] transition-colors`}
              title="Show panel"
            >
              {panelSide === "left" ? (
                <ArrowRightIcon className="w-3.5 h-3.5" />
              ) : (
                <ArrowLeftIcon className="w-3.5 h-3.5" />
              )}
            </button>
          )}
          {isTitle ? (
            /* Title slide — centered heading + subtitle */
            <div className="flex flex-col items-center justify-center text-center gap-4 max-w-2xl">
              <h1 className="text-4xl font-bold text-[rgb(var(--color-text))]">{slide.heading}</h1>
              {slide.subtitle && (
                <p className="text-lg text-[rgb(var(--color-text-secondary))] whitespace-pre-wrap leading-relaxed">{slide.subtitle}</p>
              )}
            </div>
          ) : row?.visual ? (
            <Suspense fallback={<div className="w-full max-w-2xl aspect-video rounded-lg bg-[rgb(var(--color-surface-alt))] animate-pulse" />}>
              <VisualCell visualPath={row.visual} mode="full" controlRef={visualControlRef} onPlayStateChange={setVisualPlaying} className="max-w-full max-h-full" />
            </Suspense>
          ) : screenshotSrc ? (
            <img
              src={screenshotSrc}
              alt={`Row ${currentIdx + 1}`}
              className="max-w-full max-h-full object-contain rounded-lg shadow-lg"
            />
          ) : (
            <div className="w-full max-w-2xl aspect-video rounded-lg border-2 border-dashed border-[rgb(var(--color-border))] flex items-center justify-center">
              <div className="flex flex-col items-center gap-2 text-[rgb(var(--color-text-secondary))]">
                <PhotoIcon className="w-12 h-12 opacity-30" />
                <span className="text-xs">No screenshot</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Navigation bar */}
      <div className="flex items-center justify-center gap-4 px-6 py-3 shrink-0 border-t border-[rgb(var(--color-border))]">
        <button
          onClick={goPrev}
          disabled={currentIdx === 0}
          className="p-2 rounded-lg text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="Previous (←)"
        >
          <ChevronLeftIcon className="w-5 h-5" />
        </button>

        {/* Slide dots */}
        <div className="flex items-center gap-1.5">
          {slides.map((s, i) => (
            <button
              key={i}
              onClick={() => setCurrentIdx(i)}
              className={`rounded-full transition-all ${
                i === currentIdx
                  ? "w-6 h-2 bg-[rgb(var(--color-accent))]"
                  : s.type === "title"
                    ? "w-2.5 h-2.5 bg-[rgb(var(--color-text-secondary))]/40 hover:bg-[rgb(var(--color-text-secondary))]/60"
                    : "w-2 h-2 bg-[rgb(var(--color-text-secondary))]/30 hover:bg-[rgb(var(--color-text-secondary))]/60"
              }`}
              title={s.type === "title" ? (s as any).heading : `Slide ${i + 1}`}
            />
          ))}
        </div>

        <button
          onClick={goNext}
          disabled={currentIdx === total - 1}
          className="p-2 rounded-lg text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="Next (→)"
        >
          <ChevronRightIcon className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}

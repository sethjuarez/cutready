import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  Type,
  X,
  Image as ImageIcon,
} from "lucide-react";
import { SafeMarkdown } from "./SafeMarkdown";
import type { PreviewSlide } from "./presentation/types";

const PREFS_KEY = "cutready:teleprompter:v2";

const TEXT_SIZE_MIN = 24;
const TEXT_SIZE_MAX = 96;
const TEXT_SIZE_STEP = 4;
const TEXT_SIZE_DEFAULT = 56;

// Auto-scroll speed range (px/sec). Calibrated for default 56px text:
// 35 px/s ≈ ~150 WPM (typical narration pace).
const SPEED_MIN = 10;
const SPEED_MAX = 200;
const SPEED_STEP = 5;
const SPEED_DEFAULT = 35;

interface TeleprompterPrefs {
  textSize: number;
  scrollSpeed: number;
}

function loadPrefs(): TeleprompterPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        textSize: clamp(parsed.textSize ?? TEXT_SIZE_DEFAULT, TEXT_SIZE_MIN, TEXT_SIZE_MAX),
        scrollSpeed: clamp(parsed.scrollSpeed ?? SPEED_DEFAULT, SPEED_MIN, SPEED_MAX),
      };
    }
  } catch { /* ignore */ }
  return { textSize: TEXT_SIZE_DEFAULT, scrollSpeed: SPEED_DEFAULT };
}

function savePrefs(prefs: TeleprompterPrefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

interface TeleprompterViewProps {
  slides: PreviewSlide[];
  projectRoot: string;
  /** Slide index to start on. */
  initialIndex: number;
  /** Called with the slide index that was active when the user exited. */
  onExit: (finalIndex: number) => void;
}

/**
 * Teleprompter mode — distraction-free reading view for sketch/storyboard narration.
 * One slide at a time, large markdown-rendered narrative, optional auto-scroll within
 * long content. Forces black/white display via media-control tokens regardless of theme.
 */
export function TeleprompterView({ slides, projectRoot, initialIndex, onExit }: TeleprompterViewProps) {
  // Snapshot slides + projectRoot on mount so that parent re-renders or live
  // storage updates don't disrupt the presentation (e.g. reset scroll, replace
  // content mid-sentence). Edits made while teleprompter is active will be
  // visible after the user exits and re-enters.
  const [frozenSlides] = useState(slides);
  const [frozenProjectRoot] = useState(projectRoot);

  const [currentIdx, setCurrentIdx] = useState(initialIndex);
  const [textSize, setTextSize] = useState(() => loadPrefs().textSize);
  const [scrollSpeed, setScrollSpeed] = useState(() => loadPrefs().scrollSpeed);
  const [isAutoScrolling, setIsAutoScrolling] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);
  const currentIdxRef = useRef(currentIdx);
  const isAutoScrollingRef = useRef(false);
  const scrollSpeedRef = useRef(scrollSpeed);

  const total = frozenSlides.length;
  const slide = frozenSlides[currentIdx];
  const nextSlide = currentIdx + 1 < total ? frozenSlides[currentIdx + 1] : null;

  // Keep refs synced with state for use inside long-lived listeners.
  useEffect(() => { currentIdxRef.current = currentIdx; }, [currentIdx]);
  useEffect(() => { isAutoScrollingRef.current = isAutoScrolling; }, [isAutoScrolling]);
  useEffect(() => { scrollSpeedRef.current = scrollSpeed; }, [scrollSpeed]);

  // Persist prefs.
  useEffect(() => {
    savePrefs({ textSize, scrollSpeed });
  }, [textSize, scrollSpeed]);

  const goPrev = useCallback(() => {
    setCurrentIdx((i) => Math.max(0, i - 1));
  }, []);

  const goNext = useCallback(() => {
    setCurrentIdx((i) => Math.min(total - 1, i + 1));
  }, [total]);

  const exit = useCallback(() => {
    onExit(currentIdxRef.current);
  }, [onExit]);

  // Reset scroll when the slide changes (e.g. user pressed ←/→).
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [currentIdx, textSize]);

  // Auto-scroll loop. Scrolls the current slide at the configured speed and
  // stops when the bottom is reached. The user advances slides manually with
  // ←/→ — Play does not cross slide boundaries.
  useEffect(() => {
    if (!isAutoScrolling) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }
    lastTickRef.current = 0;
    const tick = (now: number) => {
      const el = scrollRef.current;
      if (!el) return;
      if (lastTickRef.current === 0) lastTickRef.current = now;
      const dt = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;

      const next = el.scrollTop + scrollSpeedRef.current * dt;
      const max = el.scrollHeight - el.clientHeight;
      if (next >= max) {
        el.scrollTop = max;
        setIsAutoScrolling(false);
        return;
      }
      el.scrollTop = next;
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [isAutoScrolling]);

  // Pause auto-scroll on user-initiated scroll (wheel/touch). Do NOT use the
  // 'scroll' event — programmatic scrollTop updates would self-trigger.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onUserScroll = () => {
      if (isAutoScrollingRef.current) setIsAutoScrolling(false);
    };
    el.addEventListener("wheel", onUserScroll, { passive: true });
    el.addEventListener("touchmove", onUserScroll, { passive: true });
    return () => {
      el.removeEventListener("wheel", onUserScroll);
      el.removeEventListener("touchmove", onUserScroll);
    };
  }, []);

  const toggleAutoScroll = useCallback(() => {
    setIsAutoScrolling((p) => !p);
  }, []);

  const adjustSize = useCallback((delta: number) => {
    setTextSize((s) => clamp(s + delta, TEXT_SIZE_MIN, TEXT_SIZE_MAX));
  }, []);

  const adjustSpeed = useCallback((delta: number) => {
    setScrollSpeed((s) => clamp(s + delta, SPEED_MIN, SPEED_MAX));
  }, []);

  // Mode-aware keyboard handler — capture phase + stopPropagation so the
  // outer SketchPreview handler (Esc=closePreview, Space=goNext, etc.) does
  // not also fire while teleprompter is active.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Allow form fields to behave normally if any sneak in (none expected).
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

      let consumed = true;
      if (e.key === "Escape") {
        exit();
      } else if (e.key === "ArrowRight" || e.key === "PageDown") {
        goNext();
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        goPrev();
      } else if (e.key === " ") {
        toggleAutoScroll();
      } else if (e.key === "ArrowDown") {
        const el = scrollRef.current;
        if (el) el.scrollTop += textSize * 1.6;
        setIsAutoScrolling(false);
      } else if (e.key === "ArrowUp") {
        const el = scrollRef.current;
        if (el) el.scrollTop -= textSize * 1.6;
        setIsAutoScrolling(false);
      } else if (e.key === "Home") {
        setCurrentIdx(0);
      } else if (e.key === "End") {
        setCurrentIdx(total - 1);
      } else if (e.key === "+" || e.key === "=") {
        adjustSize(TEXT_SIZE_STEP);
      } else if (e.key === "-" || e.key === "_") {
        adjustSize(-TEXT_SIZE_STEP);
      } else if (e.key === "]" || e.key === "}") {
        adjustSpeed(e.shiftKey ? SPEED_STEP * 4 : SPEED_STEP);
      } else if (e.key === "[" || e.key === "{") {
        adjustSpeed(e.shiftKey ? -SPEED_STEP * 4 : -SPEED_STEP);
      } else if (e.key === "t" || e.key === "T") {
        exit();
      } else {
        consumed = false;
      }
      if (consumed) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    // Capture phase to beat the outer SketchPreview handler.
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [exit, goNext, goPrev, total, toggleAutoScroll, adjustSize, adjustSpeed, textSize]);

  // Build the displayable narrative for the current slide.
  const { primaryText, kind, heading, subtitle } = useMemo(() => {
    if (!slide) return { primaryText: "", kind: "empty" as const };
    if (slide.type === "title") {
      return {
        primaryText: "",
        kind: "title" as const,
        heading: slide.heading,
        subtitle: slide.subtitle,
      };
    }
    const row = slide.row;
    if (row.narrative && row.narrative.trim().length > 0) {
      return { primaryText: row.narrative, kind: "narrative" as const };
    }
    if (row.demo_actions && row.demo_actions.trim().length > 0) {
      return { primaryText: row.demo_actions, kind: "actions-fallback" as const };
    }
    return { primaryText: "", kind: "empty" as const };
  }, [slide]);

  // Tiny thumbnail source for current slide (screenshot only — visuals are
  // animated and would distract). Only shown when present.
  const thumbnailSrc = useMemo(() => {
    if (!slide || slide.type !== "row") return null;
    const ss = slide.row.screenshot;
    if (!ss || !frozenProjectRoot) return null;
    return convertFileSrc(`${frozenProjectRoot}/${ss}`);
  }, [slide, frozenProjectRoot]);

  // Peek text (first ~80 chars of next slide's narrative or heading).
  const peekText = useMemo(() => {
    if (!nextSlide) return null;
    const raw = nextSlide.type === "title"
      ? nextSlide.heading
      : (nextSlide.row.narrative?.trim() || nextSlide.row.demo_actions?.trim() || "");
    if (!raw) return null;
    const stripped = raw.replace(/[#*_`>\-]/g, "").replace(/\s+/g, " ").trim();
    return stripped.length > 90 ? stripped.slice(0, 87) + "…" : stripped;
  }, [nextSlide]);

  if (!slide) return null;

  // Force teleprompter color scheme (black/white) regardless of app theme.
  const containerStyle: React.CSSProperties = {
    backgroundColor: "rgb(var(--color-media-control-bg))",
    color: "rgb(var(--color-media-control-fg))",
  };

  return (
    <div
      className="fixed inset-0 z-modal flex flex-col select-none"
      style={containerStyle}
      role="dialog"
      aria-label="Teleprompter"
    >
      {/* Top status bar — minimal */}
      <div
        className="flex items-center justify-between px-6 py-3 shrink-0 border-b"
        style={{ borderColor: "rgba(255,255,255,0.12)" }}
      >
        <div className="flex items-center gap-3 text-sm" style={{ color: "rgba(255,255,255,0.65)" }}>
          <span className="font-semibold" style={{ color: "rgb(var(--color-media-control-fg))" }}>
            {slide.context}
          </span>
          <span>{currentIdx + 1} / {total}</span>
          {slide.type === "row" && slide.row.time && (
            <>
              <span style={{ color: "rgba(255,255,255,0.25)" }}>•</span>
              <span>{slide.row.time}</span>
            </>
          )}
        </div>
        <button
          onClick={exit}
          className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-md transition-colors"
          style={{ color: "rgba(255,255,255,0.7)" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "rgb(var(--color-media-control-fg))")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.7)")}
          title="Exit teleprompter (Esc)"
        >
          <X className="w-3.5 h-3.5" />
          Exit
        </button>
      </div>

      {/* Reading area */}
      <div className="flex-1 relative overflow-hidden">
        <div
          ref={scrollRef}
          className="absolute inset-0 overflow-y-auto teleprompter-scroll"
          style={{
            // Anchor the reading focus zone roughly 30% from the top.
            scrollPaddingTop: "30%",
            // Soft fade at top/bottom edges to reduce visual noise during scroll.
            maskImage:
              "linear-gradient(to bottom, transparent 0%, black 8%, black 88%, transparent 100%)",
            WebkitMaskImage:
              "linear-gradient(to bottom, transparent 0%, black 8%, black 88%, transparent 100%)",
          }}
        >
          <div
            ref={contentRef}
            className="mx-auto px-12 py-[18vh]"
            style={{
              maxWidth: "min(72rem, 95vw)",
              fontSize: `${textSize}px`,
              lineHeight: 1.4,
              fontWeight: 500,
            }}
          >
            {kind === "title" ? (
              <div className="flex flex-col gap-6 text-center">
                <h1 style={{ fontSize: `${Math.round(textSize * 1.35)}px`, fontWeight: 700, lineHeight: 1.15 }}>
                  {heading}
                </h1>
                {subtitle && (
                  <p style={{ color: "rgba(255,255,255,0.75)", lineHeight: 1.4 }}>
                    {subtitle}
                  </p>
                )}
              </div>
            ) : kind === "empty" ? (
              <div
                className="text-center italic"
                style={{ color: "rgba(255,255,255,0.4)", fontSize: `${Math.round(textSize * 0.7)}px` }}
              >
                [No narration on this slide]
              </div>
            ) : (
              <>
                {kind === "actions-fallback" && (
                  <div
                    className="mb-6 uppercase tracking-wider text-center"
                    style={{ color: "rgba(255,255,255,0.5)", fontSize: `${Math.round(textSize * 0.45)}px` }}
                  >
                    Action only — no narration
                  </div>
                )}
                <div className="prose-teleprompter">
                  <SafeMarkdown>{primaryText}</SafeMarkdown>
                </div>
              </>
            )}

            {/* Peek of next slide — dimmed, after current content */}
            {peekText && (
              <div
                className="mt-16 pt-8 border-t text-center italic"
                style={{
                  borderColor: "rgba(255,255,255,0.1)",
                  color: "rgba(255,255,255,0.35)",
                  fontSize: `${Math.round(textSize * 0.65)}px`,
                  lineHeight: 1.35,
                }}
              >
                <div
                  className="uppercase tracking-wider mb-2"
                  style={{ fontSize: `${Math.round(textSize * 0.4)}px`, color: "rgba(255,255,255,0.3)" }}
                >
                  Up next
                </div>
                {peekText}
              </div>
            )}
          </div>
        </div>

        {/* Tiny thumbnail in corner so presenter knows what's on screen */}
        {thumbnailSrc && (
          <div
            className="absolute bottom-4 right-4 rounded overflow-hidden border shadow-lg pointer-events-none"
            style={{
              width: 120,
              height: 68,
              borderColor: "rgba(255,255,255,0.2)",
              backgroundColor: "rgba(0,0,0,0.6)",
            }}
          >
            <img
              src={thumbnailSrc}
              alt=""
              className="w-full h-full object-cover opacity-80"
            />
          </div>
        )}
        {!thumbnailSrc && slide.type === "row" && !slide.row.visual && (
          <div
            className="absolute bottom-4 right-4 rounded flex items-center justify-center pointer-events-none"
            style={{
              width: 120,
              height: 68,
              borderColor: "rgba(255,255,255,0.15)",
              border: "1px dashed rgba(255,255,255,0.15)",
              color: "rgba(255,255,255,0.3)",
            }}
            aria-hidden="true"
          >
            <ImageIcon className="w-5 h-5" />
          </div>
        )}
      </div>

      {/* Controls bar */}
      <div
        className="flex items-center gap-4 px-6 py-3 shrink-0 border-t"
        style={{ borderColor: "rgba(255,255,255,0.12)" }}
      >
        {/* Prev / Next */}
        <div className="flex items-center gap-1">
          <button
            onClick={goPrev}
            disabled={currentIdx === 0}
            className="p-2 rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            style={{ color: "rgba(255,255,255,0.7)" }}
            onMouseEnter={(e) => !e.currentTarget.disabled && (e.currentTarget.style.color = "rgb(var(--color-media-control-fg))")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.7)")}
            title="Previous slide (←)"
            aria-label="Previous slide"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <button
            onClick={goNext}
            disabled={currentIdx === total - 1}
            className="p-2 rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            style={{ color: "rgba(255,255,255,0.7)" }}
            onMouseEnter={(e) => !e.currentTarget.disabled && (e.currentTarget.style.color = "rgb(var(--color-media-control-fg))")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.7)")}
            title="Next slide (→)"
            aria-label="Next slide"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>

        <div className="w-px h-5" style={{ backgroundColor: "rgba(255,255,255,0.15)" }} />

        {/* Auto-scroll play/pause */}
        <button
          onClick={toggleAutoScroll}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md transition-colors"
          style={{
            color: isAutoScrolling
              ? "rgb(var(--color-media-control-bg))"
              : "rgba(255,255,255,0.85)",
            backgroundColor: isAutoScrolling
              ? "rgb(var(--color-media-control-fg))"
              : "transparent",
          }}
          title="Toggle auto-scroll (Space)"
          aria-label={isAutoScrolling ? "Pause auto-scroll" : "Play auto-scroll"}
        >
          {isAutoScrolling ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          {isAutoScrolling ? "Pause" : "Play"}
        </button>

        {/* Speed slider */}
        <div className="flex items-center gap-2 text-xs" style={{ color: "rgba(255,255,255,0.65)" }} title="Scroll speed ([ slower / ] faster, hold Shift for big steps)">
          <span>Speed</span>
          <input
            type="range"
            min={SPEED_MIN}
            max={SPEED_MAX}
            step={SPEED_STEP}
            value={scrollSpeed}
            onChange={(e) => setScrollSpeed(Number(e.target.value))}
            className="w-28 teleprompter-range"
            aria-label="Auto-scroll speed"
          />
          <span className="tabular-nums w-8" style={{ color: "rgba(255,255,255,0.45)" }}>
            {scrollSpeed}
          </span>
        </div>

        <div className="w-px h-5" style={{ backgroundColor: "rgba(255,255,255,0.15)" }} />

        {/* Text size */}
        <div className="flex items-center gap-1 text-xs" style={{ color: "rgba(255,255,255,0.65)" }}>
          <Type className="w-3.5 h-3.5" />
          <button
            onClick={() => adjustSize(-TEXT_SIZE_STEP)}
            disabled={textSize <= TEXT_SIZE_MIN}
            className="px-2 py-0.5 rounded transition-colors disabled:opacity-30"
            style={{ color: "rgba(255,255,255,0.85)" }}
            title="Smaller text (-)"
            aria-label="Decrease text size"
          >
            −
          </button>
          <span className="tabular-nums w-8 text-center" style={{ color: "rgba(255,255,255,0.45)" }}>
            {textSize}
          </span>
          <button
            onClick={() => adjustSize(TEXT_SIZE_STEP)}
            disabled={textSize >= TEXT_SIZE_MAX}
            className="px-2 py-0.5 rounded transition-colors disabled:opacity-30"
            style={{ color: "rgba(255,255,255,0.85)" }}
            title="Larger text (+)"
            aria-label="Increase text size"
          >
            +
          </button>
        </div>

        {/* Spacer + key hint */}
        <div className="flex-1" />
        <div className="text-xs hidden md:block" style={{ color: "rgba(255,255,255,0.35)" }}>
          ←/→ navigate · Space play/pause · ↑/↓ scroll · [ ] speed · +/− size · Esc exit
        </div>
      </div>
    </div>
  );
}

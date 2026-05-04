/**
 * PresentationShell — single owner of the slide cursor and mode stack for all
 * presentation modes (slides, slide-only, teleprompter). Each mode is rendered
 * by an independent child view; the shell only routes between them.
 *
 * Mode stack semantics:
 *   - The shell mounts with [initialMode].
 *   - Switching modes pushes onto the stack (e.g. user presses T while in
 *     "slides" → stack becomes ["slides", "teleprompter"]).
 *   - Esc / explicit close pops. If the stack would become empty, the shell
 *     calls onClose instead. This is what makes "open straight to teleprompter
 *     → Esc closes the whole preview" behave correctly without coupling the
 *     close behavior to how the shell was opened.
 */
import { useCallback, useState, lazy, Suspense } from "react";
import type { PlanningRow } from "../../types/sketch";
import type { PreviewSlide, PresentationMode } from "./types";

const SlidesView = lazy(() =>
  import("./SlidesView").then((m) => ({ default: m.SlidesView }))
);
const SlideOnlyView = lazy(() =>
  import("./SlideOnlyView").then((m) => ({ default: m.SlideOnlyView }))
);
const TeleprompterView = lazy(() =>
  import("../TeleprompterView").then((m) => ({ default: m.TeleprompterView }))
);

interface PresentationShellProps {
  rows: PlanningRow[];
  projectRoot: string;
  title: string;
  onClose: () => void;
  /** If provided, these typed slides are used instead of building from rows. */
  slides?: PreviewSlide[];
  /** Mode to start in. Defaults to "slides". */
  initialMode?: PresentationMode;
  /** @deprecated Use initialMode="teleprompter". Kept for back-compat. */
  startInTeleprompter?: boolean;
}

export function PresentationShell({
  rows,
  projectRoot,
  title,
  onClose,
  slides: slidesProp,
  initialMode,
  startInTeleprompter,
}: PresentationShellProps) {
  const slides: PreviewSlide[] =
    slidesProp ?? rows.map((r) => ({ type: "row", row: r, context: title }));
  const [currentIdx, setCurrentIdx] = useState(0);

  const resolvedInitialMode: PresentationMode =
    initialMode ?? (startInTeleprompter ? "teleprompter" : "slides");
  const [modeStack, setModeStack] = useState<PresentationMode[]>([
    resolvedInitialMode,
  ]);
  const mode = modeStack[modeStack.length - 1];

  const pushMode = useCallback((m: PresentationMode) => {
    setModeStack((stack) => (stack[stack.length - 1] === m ? stack : [...stack, m]));
  }, []);

  const popOrClose = useCallback(() => {
    setModeStack((stack) => {
      if (stack.length <= 1) {
        onClose();
        return stack;
      }
      return stack.slice(0, -1);
    });
  }, [onClose]);

  if (slides.length === 0) return null;

  return (
    <Suspense fallback={null}>
      {mode === "slides" && (
        <SlidesView
          slides={slides}
          currentIdx={currentIdx}
          setCurrentIdx={setCurrentIdx}
          projectRoot={projectRoot}
          onClose={popOrClose}
          onSwitchMode={pushMode}
        />
      )}
      {mode === "slide-only" && (
        <SlideOnlyView
          slides={slides}
          currentIdx={currentIdx}
          setCurrentIdx={setCurrentIdx}
          projectRoot={projectRoot}
          onClose={popOrClose}
          onSwitchMode={pushMode}
        />
      )}
      {mode === "teleprompter" && (
        <TeleprompterView
          slides={slides}
          projectRoot={projectRoot}
          initialIndex={currentIdx}
          onExit={(finalIdx) => {
            setCurrentIdx(finalIdx);
            popOrClose();
          }}
        />
      )}
    </Suspense>
  );
}

/**
 * Back-compat shim. The slide-preview UI has been refactored into a multi-mode
 * PresentationShell (slides / slide-only / teleprompter). New code should
 * import from "./presentation/PresentationShell" directly. This re-export
 * keeps existing imports of `SketchPreview` and `PreviewSlide` working.
 */
export { PresentationShell as SketchPreview } from "./presentation/PresentationShell";
export type { PreviewSlide, PresentationMode } from "./presentation/types";

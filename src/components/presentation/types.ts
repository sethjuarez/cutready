import type { PlanningRow } from "../../types/sketch";

/** A slide in any presentation mode — either a title card or a planning row. */
export type PreviewSlide =
  | { type: "title"; heading: string; subtitle: string; context: string }
  | { type: "row"; row: PlanningRow; context: string };

/**
 * Modes the PresentationShell can render.
 *  - slides       : full slide-preview UI (screenshot + narrative + actions panel)
 *  - slide-only   : full-bleed screenshot, minimal chrome (audience / clean view)
 *  - teleprompter : large-text reading mode (issue #62)
 */
export type PresentationMode = "slides" | "slide-only" | "teleprompter";

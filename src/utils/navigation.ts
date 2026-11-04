import type { AppView } from "../stores/appStore";

export type NavId = "project" | "media" | "changes" | "chat";

/** Views shown by the Media library (narrations is the legacy name for its audio). */
export const isMediaView = (view: AppView) => view === "assets" || view === "narrations";

/** Views that cover the editor, so activating a tab has to leave them to show it. */
export const hidesEditor = (view: AppView) =>
  view === "settings" || view === "home" || view === "chat" || isMediaView(view);

/** The nav row that owns a view. Views without their own row show Documents. */
export function panelOwner(view: AppView): Exclude<NavId, "chat"> | null {
  if (isMediaView(view)) return "media";
  if (view === "changes") return view;
  if (view === "chat" || view === "home" || view === "settings") return null;
  return "project";
}

/** How many storyboards reference each sketch, from storyboard -> sketch paths. */
export function sketchUsage(membership: ReadonlyMap<string, readonly string[]>): Map<string, number> {
  const usage = new Map<string, number>();
  for (const sketches of membership.values()) {
    for (const sketch of new Set(sketches)) usage.set(sketch, (usage.get(sketch) ?? 0) + 1);
  }
  return usage;
}

/** Muted usage text for a Sketches row, or nothing for a sketch no storyboard uses. */
export function usageLabel(count: number): string | undefined {
  if (count <= 0) return undefined;
  return `in ${count} storyboard${count === 1 ? "" : "s"}`;
}

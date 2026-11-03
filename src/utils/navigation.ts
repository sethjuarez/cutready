import type { AppView } from "../stores/appStore";

export type NavId = "project" | "assets" | "narrations" | "changes" | "chat";

/** The nav row that owns the panel for a view. Views without their own row show Documents. */
export function panelOwner(view: AppView): Exclude<NavId, "chat"> | null {
  if (view === "assets" || view === "narrations" || view === "changes") return view;
  if (view === "chat" || view === "home" || view === "settings") return null;
  return "project";
}

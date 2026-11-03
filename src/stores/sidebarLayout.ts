/** Sidebar width bounds (GitHub Copilot app): default 280, min 220, max 480. */
export const SIDEBAR_DEFAULT_WIDTH = 280;
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 480;

/** Clamps a sidebar width to its bounds, leaving at least 320px of the window for content. */
export function clampSidebarWidth(width: number, viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth) {
  const desired = Math.min(SIDEBAR_MAX_WIDTH, Math.max(400, viewportWidth - 420));
  const max = Math.max(SIDEBAR_MIN_WIDTH, Math.min(desired, viewportWidth - 320));
  return Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, width));
}
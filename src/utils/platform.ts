/**
 * Platform detection and keybinding formatting utilities.
 *
 * On macOS, modifier keys are displayed using symbols (⌘, ⌥, ⇧, ⌃).
 * On other platforms, text labels are used (Ctrl, Alt, Shift).
 */

/** Whether the current platform is macOS. */
export const isMac: boolean =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** The primary modifier key name for the current platform. */
export const modKey: string = isMac ? "⌘" : "Ctrl";

/**
 * Format a keybinding string for display on the current platform.
 *
 * Input uses generic names ("Ctrl+Shift+P").
 * On macOS, outputs "⌘⇧P". On other platforms, returns the input unchanged.
 */
export function formatKeybinding(keybinding: string): string {
  if (!isMac) return keybinding;
  return keybinding
    .replace(/Ctrl\+/gi, "⌘")
    .replace(/Alt\+/gi, "⌥")
    .replace(/Shift\+/gi, "⇧")
    .replace(/Meta\+/gi, "⌘");
}

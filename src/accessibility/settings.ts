// Accessibility preferences: the persisted shape, its defaults, and the
// sanitizer every read goes through. Pure, so it can be tested without a DOM.

export type TriState = "system" | "on" | "off";

export const ANNOUNCEMENT_CATEGORIES = [
  "reasoning",
  "toolCalls",
  "commandFinished",
  "readingFiles",
  "editingDocuments",
  "agentChange",
] as const;
export type AnnouncementCategory = (typeof ANNOUNCEMENT_CATEGORIES)[number];

export interface AccessibilitySettings {
  /** Webview zoom in percent; one of ZOOM_LEVELS. */
  zoom: number;
  pointerOnHover: boolean;
  showUnderlines: boolean;
  increaseContrast: TriState;
  differentiateWithoutColor: TriState;
  /** Milliseconds; 0 keeps the toast until dismissed. */
  errorToastMs: number;
  updateToastMs: number;
  interactionHints: boolean;
  announce: Record<AnnouncementCategory, boolean>;
  keyboardShortcuts: boolean;
}

export const STORAGE_KEY = "cutready-accessibility";
export const SCHEMA_VERSION = 1;

export const ZOOM_LEVELS = [75, 90, 100, 110, 125, 150, 175, 200] as const;
export const DEFAULT_ZOOM = 100;

export const TOAST_DURATIONS: ReadonlyArray<{ ms: number; label: string }> = [
  { ms: 5_000, label: "5 seconds" },
  { ms: 10_000, label: "10 seconds" },
  { ms: 30_000, label: "30 seconds" },
  { ms: 60_000, label: "1 minute" },
  { ms: 300_000, label: "5 minutes" },
  { ms: 600_000, label: "10 minutes" },
  { ms: 1_800_000, label: "30 minutes" },
  { ms: 0, label: "Indefinite" },
];

/** macOS exposes these as system settings; elsewhere the choice is just on/off. */
export function supportsSystemPreference(mac: boolean): boolean {
  return mac;
}

export function defaultAccessibilitySettings(mac: boolean): AccessibilitySettings {
  const tri: TriState = supportsSystemPreference(mac) ? "system" : "off";
  return {
    zoom: DEFAULT_ZOOM,
    pointerOnHover: false,
    showUnderlines: false,
    increaseContrast: tri,
    differentiateWithoutColor: tri,
    errorToastMs: 10_000,
    updateToastMs: 5_000,
    interactionHints: true,
    announce: {
      reasoning: true,
      toolCalls: true,
      commandFinished: true,
      readingFiles: false,
      editingDocuments: false,
      agentChange: false,
    },
    keyboardShortcuts: true,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pickBool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

function pickTri(value: unknown, fallback: TriState, mac: boolean): TriState {
  if (value === "on" || value === "off") return value;
  if (value === "system" && supportsSystemPreference(mac)) return value;
  return fallback;
}

const pickFrom = (value: unknown, allowed: readonly number[], fallback: number) =>
  typeof value === "number" && allowed.includes(value) ? value : fallback;

/**
 * Turns whatever is stored (a JSON string, a parsed value, or nothing) into
 * valid settings. Each field falls back to its default on its own, so one
 * corrupt value never resets the rest; unknown keys are dropped.
 */
export function sanitizeAccessibilitySettings(raw: unknown, mac: boolean): AccessibilitySettings {
  const defaults = defaultAccessibilitySettings(mac);
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return defaults;
    }
  }
  if (!isRecord(parsed)) return defaults;
  // A newer schema may mean something else by the same keys.
  if (typeof parsed.version === "number" && parsed.version > SCHEMA_VERSION) return defaults;
  const source = isRecord(parsed.settings) ? parsed.settings : parsed;
  const durations = TOAST_DURATIONS.map((d) => d.ms);
  const announce = isRecord(source.announce) ? source.announce : {};
  return {
    zoom: pickFrom(source.zoom, ZOOM_LEVELS, defaults.zoom),
    pointerOnHover: pickBool(source.pointerOnHover, defaults.pointerOnHover),
    showUnderlines: pickBool(source.showUnderlines, defaults.showUnderlines),
    increaseContrast: pickTri(source.increaseContrast, defaults.increaseContrast, mac),
    differentiateWithoutColor: pickTri(source.differentiateWithoutColor, defaults.differentiateWithoutColor, mac),
    errorToastMs: pickFrom(source.errorToastMs, durations, defaults.errorToastMs),
    updateToastMs: pickFrom(source.updateToastMs, durations, defaults.updateToastMs),
    interactionHints: pickBool(source.interactionHints, defaults.interactionHints),
    announce: Object.fromEntries(
      ANNOUNCEMENT_CATEGORIES.map((key) => [key, pickBool(announce[key], defaults.announce[key])]),
    ) as Record<AnnouncementCategory, boolean>,
    keyboardShortcuts: pickBool(source.keyboardShortcuts, defaults.keyboardShortcuts),
  };
}

export function serializeAccessibilitySettings(settings: AccessibilitySettings): string {
  return JSON.stringify({ version: SCHEMA_VERSION, settings });
}

/** A tri-state preference resolved against what the OS reports. */
export function resolvePreference(pref: TriState, systemValue: boolean): boolean {
  return pref === "on" || (pref === "system" && systemValue);
}

/** Next zoom level in `direction`, clamped to the ends of ZOOM_LEVELS. */
export function stepZoom(current: number, direction: 1 | -1): number {
  const levels: readonly number[] = ZOOM_LEVELS;
  const index = levels.indexOf(current);
  if (index < 0) {
    // Off-list values snap to the nearest level in the requested direction.
    const next = direction > 0 ? levels.find((l) => l > current) : [...levels].reverse().find((l) => l < current);
    return next ?? (direction > 0 ? levels[levels.length - 1] : levels[0]);
  }
  return levels[Math.min(levels.length - 1, Math.max(0, index + direction))];
}

/** macOS traffic-light safe area in CSS px, so it stays put in device px. */
export function trafficLightSpace(zoomPercent: number): number {
  return Math.round(92 / (zoomPercent / 100));
}

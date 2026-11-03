import { create } from "zustand";
import { isMac } from "../utils/platform";
import {
  STORAGE_KEY,
  resolvePreference,
  sanitizeAccessibilitySettings,
  serializeAccessibilitySettings,
  type AccessibilitySettings,
} from "../accessibility/settings";

/** What the OS reports; `prefersContrastMore` is the CSS media query. */
export interface SystemAccessibility {
  increaseContrast: boolean;
  differentiateWithoutColor: boolean;
  prefersContrastMore: boolean;
}

interface AccessibilityState {
  settings: AccessibilitySettings;
  system: SystemAccessibility;
  update: <K extends keyof AccessibilitySettings>(key: K, value: AccessibilitySettings[K]) => void;
  setSystem: (system: Partial<SystemAccessibility>) => void;
  /** Re-reads storage (another window wrote it, or tests). */
  reload: () => void;
}

function readStored(): AccessibilitySettings {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable (privacy modes, tests); defaults apply.
  }
  return sanitizeAccessibilitySettings(raw, isMac);
}

export const useAccessibilityStore = create<AccessibilityState>((set, get) => ({
  settings: readStored(),
  system: { increaseContrast: false, differentiateWithoutColor: false, prefersContrastMore: false },
  update: (key, value) => {
    const settings = sanitizeAccessibilitySettings({ ...get().settings, [key]: value }, isMac);
    set({ settings });
    try {
      localStorage.setItem(STORAGE_KEY, serializeAccessibilitySettings(settings));
    } catch (error) {
      console.warn("[a11y] Failed to save accessibility settings:", error);
    }
  },
  setSystem: (system) => set((s) => ({ system: { ...s.system, ...system } })),
  reload: () => set({ settings: readStored() }),
}));

// Other windows (recording control, prompter) share storage; follow their writes.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) useAccessibilityStore.getState().reload();
  });
}

export function resolvedIncreaseContrast(state: Pick<AccessibilityState, "settings" | "system">): boolean {
  const { increaseContrast, prefersContrastMore } = state.system;
  return resolvePreference(state.settings.increaseContrast, increaseContrast || prefersContrastMore);
}

export function resolvedDifferentiateWithoutColor(state: Pick<AccessibilityState, "settings" | "system">): boolean {
  return resolvePreference(state.settings.differentiateWithoutColor, state.system.differentiateWithoutColor);
}

/** Non-subscribing check for keyboard handlers; read at dispatch time. */
export function shortcutsEnabled(): boolean {
  return useAccessibilityStore.getState().settings.keyboardShortcuts;
}

export function useShortcutsEnabled(): boolean {
  return useAccessibilityStore((s) => s.settings.keyboardShortcuts);
}

export function useInteractionHints(): boolean {
  return useAccessibilityStore((s) => s.settings.interactionHints);
}

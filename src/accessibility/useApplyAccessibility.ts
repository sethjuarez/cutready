import { useEffect } from "react";
import { accessibilityIpc, type SystemAccessibilityDisplay } from "../ipc/accessibility";
import {
  resolvedDifferentiateWithoutColor,
  resolvedIncreaseContrast,
  shortcutsEnabled,
  useAccessibilityStore,
} from "../stores/accessibilityStore";
import { DEFAULT_ZOOM, stepZoom } from "./settings";
import { applyZoom } from "./zoom";

type Reader = () => Promise<SystemAccessibilityDisplay | null>;

/**
 * Reads OS preferences, dropping any answer that a newer read has overtaken
 * (the first read can resolve after a later focus-triggered one).
 */
export function createSystemReader(read: Reader, apply: (value: SystemAccessibilityDisplay) => void) {
  let generation = 0;
  return async function refresh() {
    const mine = ++generation;
    let value: SystemAccessibilityDisplay | null = null;
    try {
      value = await read();
    } catch {
      value = null;
    }
    if (mine !== generation || !value) return;
    apply({
      increaseContrast: value.increaseContrast === true,
      differentiateWithoutColor: value.differentiateWithoutColor === true,
    });
  };
}

/** Writes the resolved preferences onto <html> for CSS to opt into. */
export function applyAccessibilityAttributes(
  root: HTMLElement,
  flags: { pointerOnHover: boolean; showUnderlines: boolean; increaseContrast: boolean; differentiateWithoutColor: boolean },
) {
  root.classList.toggle("pointer-on-hover", flags.pointerOnHover);
  const toggleAttr = (name: string, on: boolean) => (on ? root.setAttribute(name, "") : root.removeAttribute(name));
  toggleAttr("data-show-underlines", flags.showUnderlines);
  toggleAttr("data-increase-contrast", flags.increaseContrast);
  toggleAttr("data-differentiate-without-color", flags.differentiateWithoutColor);
}

/** Ctrl/Cmd `=`/`+`, `-` and `0`. Returns the new zoom, or null if the key isn't a zoom shortcut. */
export function zoomForShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">, current: number): number | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  if (event.key === "=" || event.key === "+") return stepZoom(current, 1);
  if (event.key === "-" || event.key === "_") return stepZoom(current, -1);
  if (event.key === "0") return DEFAULT_ZOOM;
  return null;
}

export function useApplyAccessibility() {
  const pointerOnHover = useAccessibilityStore((s) => s.settings.pointerOnHover);
  const showUnderlines = useAccessibilityStore((s) => s.settings.showUnderlines);
  const increaseContrast = useAccessibilityStore(resolvedIncreaseContrast);
  const differentiateWithoutColor = useAccessibilityStore(resolvedDifferentiateWithoutColor);
  const zoom = useAccessibilityStore((s) => s.settings.zoom);

  useEffect(() => {
    applyAccessibilityAttributes(document.documentElement, {
      pointerOnHover,
      showUnderlines,
      increaseContrast,
      differentiateWithoutColor,
    });
  }, [pointerOnHover, showUnderlines, increaseContrast, differentiateWithoutColor]);

  useEffect(() => {
    void applyZoom(zoom);
  }, [zoom]);

  // OS preferences: read on start and whenever the app regains focus (the user
  // changes them in System Settings, then comes back), plus the CSS query.
  useEffect(() => {
    const { setSystem } = useAccessibilityStore.getState();
    const refresh = createSystemReader(accessibilityIpc.getSystemAccessibilityDisplay, setSystem);
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);

    const query = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-contrast: more)") : null;
    const onQuery = () => setSystem({ prefersContrastMore: Boolean(query?.matches) });
    onQuery();
    query?.addEventListener?.("change", onQuery);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      query?.removeEventListener?.("change", onQuery);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shortcutsEnabled()) return;
      const { settings, update } = useAccessibilityStore.getState();
      const next = zoomForShortcut(event, settings.zoom);
      if (next === null) return;
      event.preventDefault();
      if (next !== settings.zoom) update("zoom", next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

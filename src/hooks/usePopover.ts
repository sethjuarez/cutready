import { useState, useRef, useEffect, useCallback } from "react";

interface PopoverPosition {
  x: number;
  y: number;
}

/** Open state is either a position (for context menus) or `true` (for toggles) */
type PopoverState = PopoverPosition | true;

interface UsePopoverReturn {
  /** Current open state — null when closed */
  state: PopoverState | null;
  /** Ref to attach to the popover container for click-outside detection */
  ref: React.RefObject<HTMLDivElement | null>;
  /** Open at a fixed position (e.g., right-click context menu) */
  openAt: (pos: PopoverPosition) => void;
  /** Open without position (e.g., dropdown toggle) */
  open: () => void;
  /** Close the popover */
  close: () => void;
  /** Toggle open/close (no position) */
  toggle: () => void;
  /** Helper: get position when opened via openAt(), or undefined */
  position: PopoverPosition | undefined;
}

/**
 * Shared popover/context-menu hook.
 * Handles open/close state, click-outside dismissal, and Escape key.
 */
export function usePopover(): UsePopoverReturn {
  const [state, setState] = useState<PopoverState | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (state === null) return;

    const handleClose = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setState(null);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setState(null);
    };

    window.addEventListener("mousedown", handleClose);
    window.addEventListener("keydown", handleEsc);
    return () => {
      window.removeEventListener("mousedown", handleClose);
      window.removeEventListener("keydown", handleEsc);
    };
  }, [state]);

  const openAt = useCallback((pos: PopoverPosition) => {
    setState(pos);
  }, []);

  const open = useCallback(() => {
    setState(true);
  }, []);

  const close = useCallback(() => {
    setState(null);
  }, []);

  const toggle = useCallback(() => {
    setState((prev) => (prev === null ? true : null));
  }, []);

  const position = state !== null && state !== true ? state : undefined;

  return { state, ref, openAt, open, close, toggle, position };
}

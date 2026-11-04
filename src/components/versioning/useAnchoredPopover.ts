import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

/** Fixed-position style that keeps a portaled popover under its trigger, inside the window. */
export function useAnchoredPopover(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  width: number,
  align: "left" | "right",
): CSSProperties | null {
  const [style, setStyle] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const effectiveWidth = Math.min(width, window.innerWidth - 16);
      const preferredLeft = align === "right" ? rect.right - effectiveWidth : rect.left;
      const left = Math.min(preferredLeft, window.innerWidth - effectiveWidth - 8);
      setStyle({ position: "fixed", left: Math.max(8, left), top: rect.bottom + 4, width: effectiveWidth });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [align, open, triggerRef, width]);

  return open ? style : null;
}

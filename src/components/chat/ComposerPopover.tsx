import type { HTMLAttributes, ReactNode, Ref, RefObject } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPopover } from "../../hooks/useAnchoredPopover";

const COMPOSER_POPOVER_ATTR = "data-composer-popover";

/** True when an event lands inside a portaled composer menu, which sits outside the chat panel's DOM. */
export function isInComposerPopover(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${COMPOSER_POPOVER_ATTR}]`) !== null;
}

/**
 * A menu that opens upward from a composer control. It is portaled to the body so the chat
 * panel's overflow can't clip it, and clamped to the window so a narrow panel can't push it off-screen.
 */
export function ComposerPopover({
  anchorRef,
  width,
  align = "left",
  maxHeight = 260,
  children,
  ref,
  style: extraStyle,
  ...rest
}: {
  anchorRef: RefObject<HTMLElement | null>;
  width: number;
  align?: "left" | "right";
  maxHeight?: number;
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
} & HTMLAttributes<HTMLDivElement>) {
  const style = useAnchoredPopover(true, anchorRef, width, align, "above");
  if (!style) return null;
  return createPortal(
    <div
      {...rest}
      ref={ref}
      {...{ [COMPOSER_POPOVER_ATTR]: "" }}
      style={{ ...extraStyle, ...style, maxHeight: Math.min(maxHeight, Number(style.maxHeight)) }}
    >
      {children}
    </div>,
    document.body,
  );
}

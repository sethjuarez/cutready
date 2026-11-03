import { useCallback, useId, useRef, useEffect, useState } from "react";
import { useInteractionHints } from "../stores/accessibilityStore";

interface ResizeHandleProps {
  direction: "horizontal" | "vertical";
  onResize: (delta: number) => void;
  onResizeEnd?: () => void;
  /** Hide the resting line; show an accent-muted bar only on hover, focus or drag. */
  subtle?: boolean;
  /** Keyboard resize: arrows step 10px, Shift+arrows 50px. Makes the handle focusable. */
  onStep?: (delta: number) => void;
  /** Double-click restores the default size. */
  onReset?: () => void;
  ariaLabel?: string;
  /** Focusable separators report the current size and its bounds, and the panel they resize. */
  value?: { now: number; min: number; max: number };
  controls?: string;
}

/**
 * ResizeHandle — draggable sash for resizing panels.
 * Shows a subtle accent line on hover/drag so users know it's interactive.
 */
export function ResizeHandle({ direction, onResize, onResizeEnd, subtle = false, onStep, onReset, ariaLabel, value, controls }: ResizeHandleProps) {
  const dragging = useRef(false);
  const lastPos = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const hintId = useId();
  const showHint = useInteractionHints() && Boolean(onStep);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragging.current = true;
      setIsDragging(true);
      lastPos.current = direction === "horizontal" ? e.clientX : e.clientY;
      document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    },
    [direction],
  );

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const current = direction === "horizontal" ? e.clientX : e.clientY;
      const delta = current - lastPos.current;
      if (delta !== 0) {
        lastPos.current = current;
        onResize(delta);
      }
    };

    const handlePointerUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      setIsDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onResizeEnd?.();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [direction, onResize, onResizeEnd]);

  // If the handle unmounts mid-drag, the pointerup listener is gone: restore the page state here.
  const endRef = useRef(onResizeEnd);
  endRef.current = onResizeEnd;
  useEffect(
    () => () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      endRef.current?.();
    },
    [],
  );

  const isHorizontal = direction === "horizontal";

  return (
    <div
      className={`shrink-0 relative group focus-visible:outline-none ${
        isHorizontal
          ? "-mx-1 w-2 cursor-col-resize"
          : "-my-1 h-2 cursor-row-resize"
      }`}
      data-testid={isHorizontal ? "resize-handle-horizontal" : "resize-handle-vertical"}
      role="separator"
      aria-orientation={isHorizontal ? "vertical" : "horizontal"}
      aria-label={ariaLabel}
      aria-valuenow={value?.now}
      aria-valuemin={value?.min}
      aria-valuemax={value?.max}
      aria-controls={controls}
      aria-describedby={showHint ? hintId : undefined}
      tabIndex={onStep ? 0 : undefined}
      onPointerDown={handlePointerDown}
      onDoubleClick={onReset}
      onKeyDown={onStep ? (event) => {
        const back = isHorizontal ? "ArrowLeft" : "ArrowUp";
        const forward = isHorizontal ? "ArrowRight" : "ArrowDown";
        if (event.key !== back && event.key !== forward) return;
        event.preventDefault();
        const step = event.shiftKey ? 50 : 10;
        onStep(event.key === back ? -step : step);
      } : undefined}
    >
      {showHint && (
        <span id={hintId} hidden>
          {`Use arrow keys to resize, Shift for larger steps.${onReset ? " Double-click to reset." : ""}`}
        </span>
      )}
      {/* Invisible wider hit area overlapping adjacent panels */}
      <div
        className={`absolute z-sticky ${
          isHorizontal
            ? "inset-y-0 left-0 w-full cursor-col-resize"
            : "inset-x-0 top-0 h-full cursor-row-resize"
        }`}
      />
      {/* Visible 1px line */}
      <div
        className={`absolute transition-colors ${subtle ? "duration-[180ms]" : "duration-150"} ${
          isHorizontal
            ? "top-0 bottom-0 left-1/2 w-px -translate-x-1/2"
            : "left-0 right-0 top-1/2 h-px -translate-y-1/2"
        } ${
          subtle
            ? `!w-0.5 ${isDragging ? "bg-[rgb(var(--color-accent)/0.4)]" : "bg-transparent group-hover:bg-[rgb(var(--color-accent)/0.4)] group-focus-visible:bg-[rgb(var(--color-accent))]"}`
            : isDragging
              ? "bg-[rgb(var(--color-accent))]"
              : "bg-[rgb(var(--color-border))] group-hover:bg-[rgb(var(--color-accent))]/50"
        }`}
      />
    </div>
  );
}

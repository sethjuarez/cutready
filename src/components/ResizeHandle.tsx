import { useCallback, useRef, useEffect, useState } from "react";

interface ResizeHandleProps {
  direction: "horizontal" | "vertical";
  onResize: (delta: number) => void;
  onResizeEnd?: () => void;
}

/**
 * ResizeHandle — draggable sash for resizing panels.
 * Shows a subtle accent line on hover/drag so users know it's interactive.
 */
export function ResizeHandle({ direction, onResize, onResizeEnd }: ResizeHandleProps) {
  const dragging = useRef(false);
  const lastPos = useRef(0);
  const [isDragging, setIsDragging] = useState(false);

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

  const isHorizontal = direction === "horizontal";

  return (
    <div
      className={`shrink-0 relative group ${
        isHorizontal
          ? "-mx-1 w-2 cursor-col-resize"
          : "-my-1 h-2 cursor-row-resize"
      }`}
      data-testid={isHorizontal ? "resize-handle-horizontal" : "resize-handle-vertical"}
      role="separator"
      aria-orientation={isHorizontal ? "vertical" : "horizontal"}
      onPointerDown={handlePointerDown}
    >
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
        className={`absolute transition-colors duration-150 ${
          isHorizontal
            ? "top-0 bottom-0 left-1/2 w-px -translate-x-1/2"
            : "left-0 right-0 top-1/2 h-px -translate-y-1/2"
        } ${
          isDragging
            ? "bg-[rgb(var(--color-accent))]"
            : "bg-[rgb(var(--color-border))] group-hover:bg-[rgb(var(--color-accent))]/50"
        }`}
      />
    </div>
  );
}

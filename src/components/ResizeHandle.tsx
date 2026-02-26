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

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      setIsDragging(true);
      lastPos.current = direction === "horizontal" ? e.clientX : e.clientY;
      document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    },
    [direction],
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const current = direction === "horizontal" ? e.clientX : e.clientY;
      const delta = current - lastPos.current;
      if (delta !== 0) {
        lastPos.current = current;
        onResize(delta);
      }
    };

    const handleMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      setIsDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onResizeEnd?.();
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [direction, onResize, onResizeEnd]);

  const isHorizontal = direction === "horizontal";

  return (
    <div
      className={`shrink-0 relative group ${
        isHorizontal
          ? "w-[5px] cursor-col-resize"
          : "h-[5px] cursor-row-resize"
      }`}
      onMouseDown={handleMouseDown}
    >
      {/* Visible 1px line centered in the grab area */}
      <div
        className={`absolute transition-colors duration-150 ${
          isHorizontal
            ? "top-0 bottom-0 left-1/2 -translate-x-1/2 w-px"
            : "left-0 right-0 top-1/2 -translate-y-1/2 h-px"
        } ${
          isDragging
            ? "bg-[var(--color-accent)]"
            : "bg-[var(--color-border)] group-hover:bg-[var(--color-accent)]/50"
        }`}
      />
    </div>
  );
}

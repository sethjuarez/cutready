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
      className={`group relative shrink-0 ${
        isHorizontal ? "w-[7px] cursor-col-resize" : "h-[7px] cursor-row-resize"
      }`}
      onMouseDown={handleMouseDown}
    >
      {/* Visible center line — appears on hover and during drag */}
      <div
        className={`absolute transition-all duration-200 ${
          isDragging
            ? "opacity-100 bg-[var(--color-accent)]"
            : "opacity-0 group-hover:opacity-100 bg-[var(--color-accent)]/40"
        } ${
          isHorizontal
            ? "top-0 bottom-0 left-1/2 -translate-x-1/2 w-[2px] rounded-full"
            : "left-0 right-0 top-1/2 -translate-y-1/2 h-[2px] rounded-full"
        }`}
      />
    </div>
  );
}

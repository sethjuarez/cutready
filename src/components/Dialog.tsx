import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface DialogProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Vertical alignment: "center" (default) or "top" */
  align?: "center" | "top";
  /** Top offset when align="top", e.g. "20vh" or "var(--titlebar-height)" */
  topOffset?: string;
  /** Width class, e.g. "w-[520px] max-w-[90vw]" */
  width?: string;
  /** Optional id for aria-labelledby */
  labelledBy?: string;
  /** Backdrop opacity, default tokenized scrim */
  backdropClass?: string;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  isOpen,
  onClose,
  children,
  align = "center",
  topOffset = "20vh",
  width,
  labelledBy,
  backdropClass = "bg-[rgb(var(--color-overlay-scrim)/0.25)]",
}: DialogProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  // Focus trap: Tab / Shift+Tab cycle within the dialog
  useEffect(() => {
    if (!isOpen) return;
    const el = contentRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = Array.from(
        el.querySelectorAll<HTMLElement>(FOCUSABLE),
      );
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [isOpen]);

  if (!isOpen) return null;

  const isTop = align === "top";

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-overlay ${backdropClass}`}
        onClick={onClose}
      />
      {/* Positioner */}
      <div
        className={`fixed inset-0 z-modal flex justify-center pointer-events-none ${
          isTop ? "items-start" : "items-center"
        }`}
        style={isTop ? { paddingTop: topOffset } : undefined}
      >
        {/* Content */}
        <div
          ref={contentRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy}
          className={`pointer-events-auto ${width ?? ""}`}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      </div>
    </>,
    document.body,
  );
}

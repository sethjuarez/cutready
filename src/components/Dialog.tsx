import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from "react";
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
  /** Optional id for aria-describedby */
  describedBy?: string;
  /** "alertdialog" for confirmations that interrupt the user */
  role?: "dialog" | "alertdialog";
  /** Backdrop opacity, default tokenized scrim */
  backdropClass?: string;
}

// Open dialogs, oldest first. Only the top one is modal and handles Escape,
// so a dialog opened from another (e.g. naming a merge) suspends the lower one.
let openStack: string[] = [];
const stackListeners = new Set<() => void>();
function setOpenStack(next: string[]) {
  openStack = next;
  stackListeners.forEach((listener) => listener());
}
function subscribeStack(listener: () => void) {
  stackListeners.add(listener);
  return () => stackListeners.delete(listener);
}
const topOfStack = () => openStack[openStack.length - 1];

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
  describedBy,
  role = "dialog",
  backdropClass = "cr-modal-backdrop",
}: DialogProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const stackId = useId();
  const isTopDialog = useSyncExternalStore(subscribeStack, topOfStack) === stackId;

  useEffect(() => {
    if (!isOpen) return;
    setOpenStack([...openStack, stackId]);
    return () => setOpenStack(openStack.filter((id) => id !== stackId));
  }, [isOpen, stackId]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && topOfStack() === stackId) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose, stackId]);

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
        inert={!isTopDialog || undefined}
        aria-hidden={!isTopDialog || undefined}
      >
        {/* Content */}
        <div
          ref={contentRef}
          role={role}
          aria-modal="true"
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
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

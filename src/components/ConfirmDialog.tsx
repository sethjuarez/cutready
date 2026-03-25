import { useEffect, useRef } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "warning" | "error";
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Auto-focus confirm button when opened
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => confirmRef.current?.focus());
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onCancel]);

  if (!open) return null;

  const variantColors = {
    default: { bg: "rgb(var(--color-accent))" },
    warning: { bg: "rgb(var(--color-warning))" },
    error: { bg: "rgb(var(--color-error))" },
  };
  const colors = variantColors[variant];

  return (
    <div className="fixed inset-0 z-[9999] flex items-start justify-center pt-[20vh]">
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} />
      <div className="relative bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
        <div className="px-5 pt-5 pb-4">
          <h2 className="text-sm font-semibold text-[rgb(var(--color-text))] mb-2">{title}</h2>
          <p className="text-xs text-[rgb(var(--color-text-secondary))] leading-relaxed whitespace-pre-line">{message}</p>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 pb-4">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg text-xs text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className="px-4 py-1.5 rounded-lg text-xs font-medium text-white transition-colors"
            style={{ backgroundColor: colors.bg }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

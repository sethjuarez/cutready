import { useEffect, useRef } from "react";
import { Dialog } from "./Dialog";

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

  if (!open) return null;

  const variantColors = {
    default: { bg: "rgb(var(--color-accent))" },
    warning: { bg: "rgb(var(--color-warning))" },
    error: { bg: "rgb(var(--color-error))" },
  };
  const colors = variantColors[variant];

  return (
    <Dialog isOpen={open} onClose={onCancel} align="top" topOffset="20vh" width="w-full max-w-sm mx-4" backdropClass="bg-[rgb(var(--color-overlay-scrim)/0.4)]">
      <div className="bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-xl shadow-2xl overflow-hidden">
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
            className="px-4 py-1.5 rounded-lg text-xs font-medium text-[rgb(var(--color-accent-fg))] transition-colors"
            style={{ backgroundColor: colors.bg }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

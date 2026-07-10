import { useCallback, useEffect, useRef, useState } from "react";
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

type ConfirmOptions = Omit<ConfirmDialogProps, "open" | "onConfirm" | "onCancel">;

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
  const cancelRef = useRef<HTMLButtonElement>(null);
  const defaultFocusRef = variant === "default" ? confirmRef : cancelRef;

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => defaultFocusRef.current?.focus());
    }
  }, [defaultFocusRef, open]);

  if (!open) return null;

  const variantColors = {
    default: { bg: "rgb(var(--color-accent))" },
    warning: { bg: "rgb(var(--color-warning))" },
    error: { bg: "rgb(var(--color-error))" },
  };
  const colors = variantColors[variant];

  return (
    <Dialog isOpen={open} onClose={onCancel} align="top" topOffset="20vh" width="w-full max-w-sm mx-4">
      <div className="cr-modal-surface rounded-xl overflow-hidden">
        <div className="px-5 pt-5 pb-4">
          <h2 className="text-sm font-semibold text-[rgb(var(--color-text))] mb-2">{title}</h2>
          <p className="text-xs text-[rgb(var(--color-text-secondary))] leading-relaxed whitespace-pre-line">{message}</p>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 pb-4">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg text-xs text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
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

export function useConfirmDialog() {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((confirmed: boolean) => void) | null>(null);

  const close = useCallback((confirmed: boolean) => {
    resolveRef.current?.(confirmed);
    resolveRef.current = null;
    setOptions(null);
  }, []);

  const confirm = useCallback((nextOptions: ConfirmOptions) => {
    resolveRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setOptions(nextOptions);
    });
  }, []);

  const confirmationDialog = (
    <ConfirmDialog
      open={!!options}
      title={options?.title ?? ""}
      message={options?.message ?? ""}
      confirmLabel={options?.confirmLabel}
      cancelLabel={options?.cancelLabel}
      variant={options?.variant}
      onConfirm={() => close(true)}
      onCancel={() => close(false)}
    />
  );

  return { confirm, confirmationDialog };
}

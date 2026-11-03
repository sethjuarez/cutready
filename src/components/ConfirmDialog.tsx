import { useCallback, useEffect, useId, useRef, useState } from "react";
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
  const titleId = useId();
  const defaultFocusRef = variant === "default" ? confirmRef : cancelRef;

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => defaultFocusRef.current?.focus());
    }
  }, [defaultFocusRef, open]);

  if (!open) return null;

  const confirmClass = {
    default: "cr-btn-accent",
    warning: "cr-btn-warning",
    error: "cr-btn-danger",
  }[variant];

  return (
    <Dialog isOpen={open} onClose={onCancel} align="top" topOffset="20vh" width="w-full max-w-sm mx-4" labelledBy={titleId}>
      <div className="cr-modal-surface overflow-hidden">
        <div className="px-5 pt-5 pb-4">
          <h2 id={titleId} className="mb-2 text-[15px] font-semibold text-[rgb(var(--color-text))]">{title}</h2>
          <p className="whitespace-pre-line text-sm text-[rgb(var(--color-text-secondary))]">{message}</p>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 pb-4">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="cr-btn"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={`cr-btn ${confirmClass}`}
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

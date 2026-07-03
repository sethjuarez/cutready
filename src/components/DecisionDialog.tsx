import type { ReactNode } from "react";
import { AlertTriangle, Sparkles } from "lucide-react";
import { Dialog } from "./Dialog";

export interface DecisionDialogAction {
  id: string;
  label: string;
  onSelect: () => void | Promise<void>;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
}

interface DecisionDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  icon?: "warning" | "ai";
  actions: DecisionDialogAction[];
  onClose: () => void;
}

export function DecisionDialog({
  open,
  title,
  message,
  icon = "warning",
  actions,
  onClose,
}: DecisionDialogProps) {
  if (!open) return null;

  const Icon = icon === "ai" ? Sparkles : AlertTriangle;

  return (
    <Dialog isOpen={open} onClose={onClose} align="top" topOffset="18vh" width="w-full max-w-lg mx-4">
      <div className="cr-modal-surface overflow-hidden rounded-2xl">
        <div className="flex items-start gap-3 border-b border-[rgb(var(--color-border))] px-5 py-4">
          <div className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl ${
            icon === "ai"
              ? "bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]"
              : "bg-[rgb(var(--color-warning))]/10 text-[rgb(var(--color-warning))]"
          }`}>
            <Icon className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-[rgb(var(--color-text))]">{title}</h2>
            <div className="mt-1 text-xs leading-5 text-[rgb(var(--color-text-secondary))]">{message}</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-4">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={action.disabled}
              onClick={() => void action.onSelect()}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:pointer-events-none disabled:opacity-45 ${
                action.variant === "danger"
                  ? "bg-error text-[rgb(var(--color-accent-fg))] hover:bg-error/80"
                  : action.variant === "primary"
                    ? "bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] hover:bg-[rgb(var(--color-accent-hover))]"
                    : "border border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
              }`}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

import { useId, type ReactNode } from "react";
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
  const titleId = useId();

  if (!open) return null;

  const Icon = icon === "ai" ? Sparkles : AlertTriangle;

  return (
    <Dialog isOpen={open} onClose={onClose} align="top" topOffset="18vh" width="w-full max-w-lg mx-4" labelledBy={titleId}>
      <div className="cr-modal-surface overflow-hidden">
        <div className="flex items-start gap-3 border-b border-[rgb(var(--color-border))] px-5 py-4">
          <div className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-card ${
            icon === "ai"
              ? "bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]"
              : "bg-[rgb(var(--color-warning))]/10 text-[rgb(var(--color-warning))]"
          }`}>
            <Icon aria-hidden="true" className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[15px] font-semibold text-[rgb(var(--color-text))]">{title}</h2>
            <div className="mt-1 text-sm text-[rgb(var(--color-text-secondary))]">{message}</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-4">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={action.disabled}
              onClick={() => void action.onSelect()}
              className={`cr-btn ${
                action.variant === "danger"
                  ? "cr-btn-danger"
                  : action.variant === "primary"
                    ? "cr-btn-accent"
                    : ""
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

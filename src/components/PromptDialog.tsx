import { useEffect, useId, useRef, type ReactNode } from "react";
import { Dialog } from "./Dialog";

export interface PromptDialogField {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export interface PromptDialogAction {
  id: string;
  label: string;
  onSelect: () => void | Promise<void>;
  variant?: "primary" | "secondary";
  disabled?: boolean;
}

interface PromptDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  icon: ReactNode;
  fields: PromptDialogField[];
  actions: PromptDialogAction[];
  onClose: () => void;
  notice?: ReactNode;
  noticeTone?: "neutral" | "accent";
  focusKey?: string | number;
}

export function PromptDialog({
  open,
  title,
  description,
  icon,
  fields,
  actions,
  onClose,
  notice,
  noticeTone = "neutral",
  focusKey,
}: PromptDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const primaryAction = actions.find((action) => action.variant === "primary") ?? actions[actions.length - 1];

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [focusKey, open]);

  if (!open) return null;

  return (
    <Dialog isOpen={open} onClose={onClose} align="top" topOffset="18vh" width="w-full max-w-lg mx-4" labelledBy={titleId}>
      <div className="cr-modal-surface overflow-hidden">
        <div className="px-5 pb-5 pt-5">
          <div className="mb-4 flex items-start gap-3">
            <div className="rounded-card bg-[rgb(var(--color-accent))]/10 p-2 text-[rgb(var(--color-accent))]" aria-hidden="true">
              {icon}
            </div>
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-[15px] font-semibold text-[rgb(var(--color-text))]">{title}</h2>
              <div className="mt-1 text-sm text-[rgb(var(--color-text-secondary))]">
                {description}
              </div>
            </div>
          </div>

          {notice && (
            <div className={`mb-4 rounded-card border p-3 text-sm ${
              noticeTone === "accent"
                ? "border-[rgb(var(--color-accent))]/20 bg-[rgb(var(--color-accent))]/10"
                : "border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/80"
            }`}>
              {notice}
            </div>
          )}

          <div className="mb-4 flex flex-col gap-3">
            {fields.map((field, index) => (
              <label key={field.id} htmlFor={field.id}>
                <span className="mb-1.5 block text-sm font-medium text-[rgb(var(--color-text))]">
                  {field.label}
                </span>
                <input
                  id={field.id}
                  ref={index === 0 ? inputRef : undefined}
                  type="text"
                  value={field.value}
                  onChange={(event) => field.onChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && primaryAction && !primaryAction.disabled) {
                      void primaryAction.onSelect();
                    }
                  }}
                  placeholder={field.placeholder}
                  className="cr-input"
                />
              </label>
            ))}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                onClick={() => void action.onSelect()}
                disabled={action.disabled}
                className={
                  action.variant === "primary"
                    ? "cr-btn cr-btn-accent"
                    : "cr-btn"
                }
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

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
      <div className="cr-modal-surface overflow-hidden rounded-2xl border border-[rgb(var(--color-accent))]/20">
        <div className="relative px-5 pb-5 pt-5">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[rgb(var(--color-accent))]/20 via-[rgb(var(--color-accent))] to-[rgb(var(--color-accent))]/20" />
          <div className="mb-4 flex items-start gap-3">
            <div className="rounded-xl border border-[rgb(var(--color-accent))]/20 bg-[rgb(var(--color-accent))]/10 p-2.5 text-[rgb(var(--color-accent))]">
              {icon}
            </div>
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-sm font-semibold text-[rgb(var(--color-text))]">{title}</h2>
              <div className="mt-1 text-xs leading-relaxed text-[rgb(var(--color-text-secondary))]">
                {description}
              </div>
            </div>
          </div>

          {notice && (
            <div className={`mb-4 rounded-xl border p-3 ${
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
                <span className="mb-1.5 block text-xs font-medium text-[rgb(var(--color-text-secondary))]">
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
                  className="w-full rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2 text-sm text-[rgb(var(--color-text))] outline-none transition-colors placeholder:text-[rgb(var(--color-text-secondary))]/45 focus:border-[rgb(var(--color-accent))] focus:ring-2 focus:ring-[rgb(var(--color-accent))]/20"
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
                    ? "rounded-lg bg-[rgb(var(--color-accent))] px-4 py-1.5 text-xs font-semibold text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))] disabled:pointer-events-none disabled:opacity-40"
                    : "rounded-lg px-3 py-1.5 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
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

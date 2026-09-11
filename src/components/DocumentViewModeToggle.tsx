import type { ReactNode } from "react";

export type DocumentViewMode = "text" | "balanced" | "screen";

const VIEW_MODES: Array<{ id: DocumentViewMode; label: string; title: string }> = [
  { id: "text", label: "Text", title: "Text-heavy authoring view" },
  { id: "balanced", label: "Balanced", title: "Equal screen and text view" },
  { id: "screen", label: "Screen", title: "Screen-heavy visual view" },
];

export function DocumentViewModeToggle({
  value,
  onChange,
  label = "View density",
  actions,
}: {
  value: DocumentViewMode;
  onChange: (value: DocumentViewMode) => void;
  label?: string;
  actions?: ReactNode;
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))]/45 px-3 py-2"
      role="group"
      aria-label={label}
    >
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/70 p-0.5">
          {VIEW_MODES.map((mode) => {
            const active = mode.id === value;
            return (
              <button
                key={mode.id}
                type="button"
                onClick={() => onChange(mode.id)}
                title={mode.title}
                aria-pressed={active}
                className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                  active
                    ? "bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] shadow-sm"
                    : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
                }`}
              >
                {mode.label}
              </button>
            );
          })}
        </div>
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/70 p-0.5">
          {actions}
        </div>
      )}
    </div>
  );
}

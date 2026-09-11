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
}: {
  value: DocumentViewMode;
  onChange: (value: DocumentViewMode) => void;
  label?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))]/45 px-3 py-2">
      <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[rgb(var(--color-text-secondary))]/70">
        {label}
      </span>
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
  );
}

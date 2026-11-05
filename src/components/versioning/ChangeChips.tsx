import type { SummaryChip } from "../../domain/changes";

/** Rounded chips such as "+3 rows" or "1 sketch edited"; conflicts are shown in the error tone. */
export function ChangeChips({ chips }: { chips: SummaryChip[] }) {
  return (
    <>
      {chips.map((chip) => (
        <span
          key={chip.id}
          data-chip={chip.id}
          className={`rounded-full px-2 py-0.5 text-2xs font-medium ${
            chip.id === "conflicts" ? "bg-error/10 text-error" : "bg-[rgb(var(--color-surface-alt))] text-[rgb(var(--color-text-secondary))]"
          }`}
        >
          {chip.label}
        </span>
      ))}
    </>
  );
}

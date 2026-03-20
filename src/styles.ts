/**
 * Shared CSS class utilities used across multiple components.
 * Keeps styling consistent and avoids duplication.
 */

/** Standard text input styling with focus ring */
export const inputClass =
  "px-3 py-2 rounded-lg bg-[var(--color-surface-alt)] border border-[var(--color-border)] text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40";

/** Tab button class — active/inactive states for horizontal tab bars */
export const tabBtnClass = (active: boolean) =>
  `px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
    active
      ? "border-[var(--color-accent)] text-[var(--color-text)]"
      : "border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:border-[var(--color-text-secondary)]/30"
  }`;

/** Primary action button */
export const btnPrimary =
  "px-4 py-2 rounded-lg text-sm font-medium bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 transition-colors";

/** Ghost/transparent button */
export const btnGhost =
  "px-3 py-1.5 rounded-lg text-sm font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-alt)] transition-colors";

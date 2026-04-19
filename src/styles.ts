/**
 * Shared CSS class utilities used across multiple components.
 * Keeps styling consistent and avoids duplication.
 */

/** Standard text input styling with focus ring */
export const inputClass =
  "px-3 py-2 rounded-lg bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] text-sm text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]/40";

/** Tab button class — active/inactive states for horizontal tab bars */
export const tabBtnClass = (active: boolean) =>
  `px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
    active
      ? "border-[rgb(var(--color-accent))] text-[rgb(var(--color-text))]"
      : "border-transparent text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:border-[rgb(var(--color-text-secondary))]/30"
  }`;

/** Primary action button */
export const btnPrimary =
  "px-4 py-2 rounded-lg text-sm font-medium bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] hover:bg-[rgb(var(--color-accent-hover))] disabled:opacity-50 transition-colors";

/** Ghost/transparent button */
export const btnGhost =
  "px-3 py-1.5 rounded-lg text-sm font-medium text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors";

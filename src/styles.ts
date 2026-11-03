/**
 * Shared CSS class utilities used across multiple components.
 * Keeps styling consistent and avoids duplication.
 */

/** Standard text input styling: control radius, stronger bottom edge, focus ring. */
export const inputClass =
  "px-2.5 py-1.5 rounded-control bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] border-b-[rgb(var(--color-text-secondary))]/80 text-sm text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/70 transition-colors duration-fast ease-fluent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]/40";

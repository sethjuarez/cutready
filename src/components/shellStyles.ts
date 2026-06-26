export const titlebarButtonClass =
  "flex items-center justify-center w-7 h-6 rounded transition-colors text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))]";

export function titlebarToggleClass(active: boolean): string {
  return `flex items-center justify-center w-7 h-6 rounded transition-colors ${
    active
      ? "bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]"
      : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
  } hover:bg-[rgb(var(--color-surface-alt))]`;
}

export function activityButtonClass(active: boolean, disabled = false): string {
  return `flex items-center justify-center w-9 h-9 rounded-md transition-colors relative ${
    active
      ? "bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]"
      : disabled
        ? "text-[rgb(var(--color-text-secondary))]/35 cursor-not-allowed"
        : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
  }`;
}

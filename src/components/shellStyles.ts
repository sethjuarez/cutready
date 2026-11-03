export function activityButtonClass(active: boolean, disabled = false): string {
  return `flex items-center justify-center w-9 h-9 rounded-md transition-colors relative ${
    active
      ? "bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]"
      : disabled
        ? "text-[rgb(var(--color-text-secondary))]/35 cursor-not-allowed"
        : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
  }`;
}

import type { ReactNode } from "react";

export function BannerButton({ onClick, disabled, label, testId, autoFocus, children }: {
  onClick: () => void;
  disabled?: boolean;
  label?: string;
  testId?: string;
  autoFocus?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      data-testid={testId}
      autoFocus={autoFocus}
      className="shrink-0 rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-2 py-0.5 text-xs font-medium text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-inset))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))] disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function BannerRow({ icon, testId, children }: { icon: ReactNode; testId: string; children: ReactNode }) {
  return (
    <div
      data-testid={testId}
      role="status"
      className="flex items-center gap-2 border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-3 py-1.5 text-xs text-[rgb(var(--color-text-secondary))]"
    >
      {icon}
      {children}
    </div>
  );
}

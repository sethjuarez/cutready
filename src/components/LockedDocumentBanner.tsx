import { Lock } from "lucide-react";

export function LockedDocumentBanner({ message }: { message: string }) {
  return (
    <div className="mb-3 flex items-center gap-2 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/55 px-3 py-2 text-xs text-[rgb(var(--color-text-secondary))]">
      <Lock className="h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-warning))]" />
      <span>{message}</span>
    </div>
  );
}

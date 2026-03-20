import { CheckIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useToastStore } from "../stores/toastStore";

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 items-end">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] shadow-lg text-[12px] text-[var(--color-text)]"
          style={{ animation: "toastIn 0.2s ease-out" }}
        >
          <CheckIcon className="w-3.5 h-3.5" style={{ stroke: "var(--color-accent)" }} />
          <span>{t.message}</span>
          <button
            onClick={() => dismiss(t.id)}
            className="p-0.5 ml-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
          >
            <XMarkIcon className="w-2.5 h-2.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

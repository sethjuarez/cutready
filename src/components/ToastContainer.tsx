import {
  CheckIcon,
  XMarkIcon,
  XCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
} from "@heroicons/react/24/outline";
import { useToastStore, type ToastType } from "../stores/toastStore";

const toastIconMap: Record<
  ToastType,
  { icon: React.ComponentType<React.SVGProps<SVGSVGElement>>; color: string }
> = {
  success: { icon: CheckIcon, color: "var(--color-success)" },
  error: { icon: XCircleIcon, color: "var(--color-error)" },
  warning: { icon: ExclamationTriangleIcon, color: "var(--color-warning)" },
  info: { icon: InformationCircleIcon, color: "var(--color-accent)" },
};

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 items-end">
      {toasts.map((t) => {
        const { icon: Icon, color } = toastIconMap[t.type];
        return (
          <div
            key={t.id}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] shadow-lg text-[12px] text-[var(--color-text)]"
            style={{
              animation: "toastIn 0.2s ease-out",
              borderLeftWidth: 3,
              borderLeftColor: color,
            }}
          >
            <Icon className="w-3.5 h-3.5 shrink-0" style={{ stroke: color }} />
            <span>{t.message}</span>
            <button
              onClick={() => dismiss(t.id)}
              className="p-0.5 ml-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
            >
              <XMarkIcon className="w-2.5 h-2.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

import {
  Check,
  X,
  XCircle,
  AlertTriangle,
  Info,
  type LucideIcon,
} from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { useToastStore, type ToastType } from "../stores/toastStore";

const toastIconMap: Record<
  ToastType,
  { icon: LucideIcon; color: string }
> = {
  success: { icon: Check, color: "rgb(var(--color-success))" },
  error: { icon: XCircle, color: "rgb(var(--color-error))" },
  warning: { icon: AlertTriangle, color: "rgb(var(--color-warning))" },
  info: { icon: Info, color: "rgb(var(--color-accent))" },
};

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  // Always mounted so screen readers hear toasts added to an existing region.
  return (
    <div
      role="region"
      aria-label="Notifications"
      className="fixed top-4 right-4 z-toast flex flex-col gap-2 items-end"
    >
      {toasts.map((t) => {
        const { icon: Icon, color } = toastIconMap[t.type];
        return (
          <div
            key={t.id}
            role={t.type === "error" ? "alert" : "status"}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] shadow-lg text-xs text-[rgb(var(--color-text))]"
            style={{
              animation: "toastIn 0.2s ease-out",
              borderLeftWidth: 3,
              borderLeftColor: color,
            }}
          >
            <Icon aria-hidden="true" className="w-3.5 h-3.5 shrink-0" style={{ stroke: color }} />
            <span>{t.message}</span>
            {t.link && (
              <button
                type="button"
                onClick={() => {
                  void shellOpen(t.link!.url).catch((err) => console.warn("Failed to open link:", err));
                }}
                title={t.link.url}
                className="show-underlines-target ml-1 font-medium text-[rgb(var(--color-accent))] hover:underline"
              >
                {t.link.label}
              </button>
            )}
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
              className="p-0.5 ml-1 text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors"
            >
              <X aria-hidden="true" className="w-2.5 h-2.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

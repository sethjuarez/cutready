import { create } from "zustand";
import { useAccessibilityStore } from "./accessibilityStore";

export type ToastType = "success" | "error" | "warning" | "info";

/** Optional link (opened in the system browser) or in-app action rendered on a toast. */
export type ToastLink =
  | { label: string; url: string; onSelect?: never }
  | { label: string; onSelect: () => void; url?: never };

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
  link?: ToastLink;
}

let nextId = 0;

interface ToastState {
  toasts: Toast[];
  /** Error toasts use the Accessibility error duration instead of `durationMs`. */
  show: (message: string, durationMs?: number, type?: ToastType, link?: ToastLink) => void;
  /** Incoming-work toasts, timed by the Accessibility update duration. */
  showUpdate: (message: string, type?: Exclude<ToastType, "error">, link?: ToastLink) => void;
  dismiss: (id: number) => void;
}

/** How long a toast stays up; 0 keeps it until dismissed. */
export function toastDuration(type: ToastType, requestedMs: number): number {
  return type === "error" ? useAccessibilityStore.getState().settings.errorToastMs : requestedMs;
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  show: (message, durationMs = 3000, type = "success", link) => {
    const id = ++nextId;
    const lifetime = toastDuration(type, durationMs);
    // Repeating a visible toast restarts it instead of stacking a copy.
    set((s) => ({
      toasts: [
        ...s.toasts.filter((t) => t.message !== message || t.type !== type),
        link ? { id, message, type, link } : { id, message, type },
      ],
    }));
    if (lifetime > 0) {
      setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), lifetime);
    }
  },
  showUpdate: (message, type = "info", link) => {
    const ms = useAccessibilityStore.getState().settings.updateToastMs;
    get().show(message, ms, type, link);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

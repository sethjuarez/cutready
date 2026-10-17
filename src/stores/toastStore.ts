import { create } from "zustand";

export type ToastType = "success" | "error" | "warning" | "info";

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

let nextId = 0;

interface ToastState {
  toasts: Toast[];
  show: (message: string, durationMs?: number, type?: ToastType) => void;
  dismiss: (id: number) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  show: (message, durationMs = 3000, type = "success") => {
    const id = ++nextId;
    // Repeating a visible toast restarts it instead of stacking a copy.
    set((s) => ({
      toasts: [
        ...s.toasts.filter((t) => t.message !== message || t.type !== type),
        { id, message, type },
      ],
    }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), durationMs);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

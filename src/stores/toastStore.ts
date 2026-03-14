import { create } from "zustand";

export interface Toast {
  id: number;
  message: string;
}

let nextId = 0;

interface ToastState {
  toasts: Toast[];
  show: (message: string, durationMs?: number) => void;
  dismiss: (id: number) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  show: (message, durationMs = 3000) => {
    const id = ++nextId;
    set((s) => ({ toasts: [...s.toasts, { id, message }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), durationMs);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

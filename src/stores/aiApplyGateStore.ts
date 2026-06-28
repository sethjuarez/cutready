import { create } from "zustand";

interface AiApplyRequest {
  label: string;
  resolve: (approved: "cancel" | "once" | "always") => void;
}

interface AiApplyGateState {
  request: AiApplyRequest | null;
  requestApproval: (label: string) => Promise<"cancel" | "once" | "always">;
  resolve: (approved: "cancel" | "once" | "always") => void;
}

export const useAiApplyGateStore = create<AiApplyGateState>((set, get) => ({
  request: null,
  requestApproval: (label) => new Promise((resolve) => {
    get().request?.resolve("cancel");
    set({ request: { label, resolve } });
  }),
  resolve: (approved) => {
    get().request?.resolve(approved);
    set({ request: null });
  },
}));


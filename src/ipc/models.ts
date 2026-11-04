// Typed wrapper for listing the models a provider connection offers.
import { invoke } from "../services/tauri";
import type { buildProviderConfig } from "../utils/providerConfig";

type ProviderConfig = ReturnType<typeof buildProviderConfig>;

export interface ProviderModel {
  id: string;
  name: string;
  owned_by?: string;
  capabilities?: Record<string, string>;
  context_length?: number;
}

export const modelsIpc = {
  list: (config: ProviderConfig) => invoke<ProviderModel[]>("list_models", { config }),
};

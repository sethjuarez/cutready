// Typed OAuth wrappers. Tokens cross IPC in the camelCase TokenResponse shape.
import { invoke } from "../services/tauri";
import type { TokenResponse } from "../types/auth";

export const authIpc = {
  /** Exchanges an Azure refresh token for a fresh access token. */
  refreshAzureToken: (tenantId: string, refreshToken: string, clientId: string | null) =>
    invoke<TokenResponse>("azure_token_refresh", { tenantId, refreshToken, clientId }),
};

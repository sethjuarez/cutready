// Prompty's canonical OAuthToken wire form, returned verbatim by Tauri.
// Azure's snake_case HTTP response is normalized inside prompty-foundry.
export interface TokenResponse {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  refreshToken?: string;
  scope?: string;
}

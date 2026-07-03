import { invoke } from "./tauri";

export interface GitHubDeviceCodeStartResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface GitHubAccount {
  login: string;
  name?: string | null;
  avatarUrl?: string | null;
  htmlUrl?: string | null;
}

export interface GitHubCliStatus {
  installed: boolean;
  authenticated: boolean;
  path?: string | null;
}

export interface GitHubAuthStatus {
  clientConfigured: boolean;
  connected: boolean;
  account?: GitHubAccount | null;
  credentialSource?: string | null;
  ghCli: GitHubCliStatus;
}

export interface GitHubAuthCompleteResult {
  account: GitHubAccount;
}

export function getGitHubAuthStatus(): Promise<GitHubAuthStatus> {
  return invoke<GitHubAuthStatus>("github_auth_status");
}

export function startGitHubDeviceCode(): Promise<GitHubDeviceCodeStartResult> {
  return invoke<GitHubDeviceCodeStartResult>("github_device_code_start", {});
}

export function pollGitHubDeviceCode(
  deviceCode: string,
  interval: number,
  timeout: number,
): Promise<GitHubAuthCompleteResult> {
  return invoke<GitHubAuthCompleteResult>("github_device_code_poll", {
    deviceCode,
    interval,
    timeout,
  });
}

export function signOutGitHub(): Promise<void> {
  return invoke<void>("github_sign_out");
}

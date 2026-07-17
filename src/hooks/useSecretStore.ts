/**
 * Encrypted secret storage via Tauri Stronghold.
 *
 * Wraps the Stronghold plugin to provide a simple get/set/remove API
 * for sensitive credentials (API keys, OAuth tokens).
 * Falls back to in-memory storage when running in browser dev mode.
 */

/** Keys that should be stored encrypted rather than in plaintext settings. */
export const SECRET_KEYS = [
  "aiApiKey",
  "aiAccessToken",
  "aiRefreshToken",
  "repoToken",
] as const;

export type SecretKey = (typeof SECRET_KEYS)[number];

export const PROVIDER_SECRET_NAMES = [
  "apiKey",
  "accessToken",
  "refreshToken",
  "managementToken",
] as const;

export type ProviderSecretName = (typeof PROVIDER_SECRET_NAMES)[number];

export function providerSecretKey(providerId: string, name: ProviderSecretName): string {
  return `aiProviders.${providerId}.${name}`;
}

/** Check whether a settings key is a secret that belongs in the vault. */
export function isSecretKey(key: string): key is SecretKey {
  return (SECRET_KEYS as readonly string[]).includes(key);
}

// ── Browser fallback (in-memory, unencrypted) ──────────────────────

const isTauri = !!(window as any).__TAURI_INTERNALS__;
const memStore = new Map<string, string>();

// ── Singleton vault (lazy-initialized) ─────────────────────────────

let _store: any = null; // Stronghold Client store
let _stronghold: any = null; // Stronghold instance (for .save())
let _initPromise: Promise<void> | null = null;

const VAULT_FILE = "vault.hold";
const VAULT_PASS = "com.cutready.app";
const CLIENT_NAME = "cutready";

/** Race a promise against a timeout. Rejects if the timeout fires first. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

const STRONGHOLD_TIMEOUT_MS = 10000;
const STRONGHOLD_MAX_INIT_ATTEMPTS = 2;
const STRONGHOLD_RETRY_DELAY_MS = 500;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function initStrongholdOnce(): Promise<void> {
  const { Stronghold } = await import("@tauri-apps/plugin-stronghold");
  const { appDataDir } = await import("@tauri-apps/api/path");
  const dir = await appDataDir();
  const vaultPath = `${dir}${VAULT_FILE}`;
  _stronghold = await withTimeout(
    Stronghold.load(vaultPath, VAULT_PASS),
    STRONGHOLD_TIMEOUT_MS,
    "Stronghold.load",
  );
  try {
    const client = await _stronghold.loadClient(CLIENT_NAME);
    _store = client.getStore();
  } catch {
    const client = await _stronghold.createClient(CLIENT_NAME);
    _store = client.getStore();
  }
}

async function ensureInit(): Promise<void> {
  if (_store) return;
  if (!isTauri) return; // Browser mode — use memStore
  if (!_initPromise) {
    _initPromise = initStrongholdOnce().catch((err) => {
      _store = null;
      _stronghold = null;
      _initPromise = null;
      console.warn("[secrets] Stronghold initialization failed; will retry on the next secret access:", err);
      throw err;
    });
  }
  await _initPromise;
}

async function ensureInitWithRetry(): Promise<boolean> {
  if (!isTauri) return false;
  for (let attempt = 1; attempt <= STRONGHOLD_MAX_INIT_ATTEMPTS; attempt++) {
    try {
      await ensureInit();
      return !!_store;
    } catch (err) {
      if (attempt === STRONGHOLD_MAX_INIT_ATTEMPTS) {
        console.warn("[secrets] Stronghold unavailable after retry; using in-memory fallback for this operation:", err);
        return false;
      }
      await delay(STRONGHOLD_RETRY_DELAY_MS);
    }
  }
  return false;
}

// ── Public API ─────────────────────────────────────────────────────

async function getSecretValue(key: string): Promise<string> {
  await ensureInitWithRetry();
  if (!_store) return memStore.get(key) ?? "";
  try {
    const data = await _store.get(key);
    if (!data || data.length === 0) return "";
    return new TextDecoder().decode(new Uint8Array(data));
  } catch {
    return "";
  }
}

async function setSecretValue(key: string, value: string): Promise<void> {
  await ensureInitWithRetry();
  if (!_store) {
    memStore.set(key, value);
    return;
  }
  const data = Array.from(new TextEncoder().encode(value));
  await _store.insert(key, data);
  await _stronghold.save();
}

async function removeSecretValue(key: string): Promise<void> {
  await ensureInitWithRetry();
  if (!_store) {
    memStore.delete(key);
    return;
  }
  try {
    await _store.remove(key);
    await _stronghold.save();
  } catch {
    // Key didn't exist — that's fine
  }
}

export async function getSecret(key: SecretKey): Promise<string> {
  return getSecretValue(key);
}

export async function setSecret(key: SecretKey, value: string): Promise<void> {
  return setSecretValue(key, value);
}

export async function removeSecret(key: SecretKey): Promise<void> {
  return removeSecretValue(key);
}

export async function getProviderSecret(providerId: string, name: ProviderSecretName): Promise<string> {
  return getSecretValue(providerSecretKey(providerId, name));
}

export async function setProviderSecret(providerId: string, name: ProviderSecretName, value: string): Promise<void> {
  return setSecretValue(providerSecretKey(providerId, name), value);
}

export async function removeProviderSecret(providerId: string, name: ProviderSecretName): Promise<void> {
  return removeSecretValue(providerSecretKey(providerId, name));
}

export async function loadProviderSecrets(providerId: string): Promise<Record<ProviderSecretName, string>> {
  const result = {} as Record<ProviderSecretName, string>;
  for (const name of PROVIDER_SECRET_NAMES) {
    result[name] = await getProviderSecret(providerId, name);
  }
  return result;
}

/** Load all secrets at once (used during settings init). */
export async function loadAllSecrets(): Promise<Record<SecretKey, string>> {
  const result = {} as Record<SecretKey, string>;
  for (const key of SECRET_KEYS) {
    result[key] = await getSecret(key);
  }
  return result;
}

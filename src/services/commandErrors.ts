import type { CmdErrorCode } from "../contracts/generated/model/cmd-error";

const FILE_EXISTS: CmdErrorCode = "file_exists";
const LEGACY_FILE_EXISTS_PREFIX = "FILE_EXISTS:";

/**
 * Text for a caught error exactly as `String(error)` rendered it when commands
 * rejected with plain strings: a `CmdError` rejection shows its `message`, and
 * anything else (strings, JS `Error`s) still goes through `String()`.
 */
export function commandErrorText(error: unknown): string {
  if (error && typeof error === "object" && !(error instanceof Error)) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

/**
 * The destination path when `transfer_asset` refused because the file already
 * exists, or null for any other failure. Reads the `file_exists` CmdError and
 * still accepts the legacy `FILE_EXISTS:<path>` string.
 */
export function transferConflictPath(error: unknown): string | null {
  if (typeof error === "string") {
    return error.startsWith(LEGACY_FILE_EXISTS_PREFIX) ? error.slice(LEGACY_FILE_EXISTS_PREFIX.length) : null;
  }
  if (!error || typeof error !== "object") return null;
  const { code, message, details } = error as { code?: unknown; message?: unknown; details?: { path?: unknown } };
  if (code !== FILE_EXISTS) return null;
  if (typeof details?.path === "string") return details.path;
  return typeof message === "string" && message.startsWith(LEGACY_FILE_EXISTS_PREFIX)
    ? message.slice(LEGACY_FILE_EXISTS_PREFIX.length)
    : "";
}

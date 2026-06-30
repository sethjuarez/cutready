const REDACTED_SECRET = "<redacted secret>";
const REDACTED_LOCAL_PATH = "<redacted local path>";
const REDACTED_MACHINE = "<redacted machine>";
const REDACTED_USER = "<redacted user>";

const DIAGNOSTIC_PATH_KEYS = new Set([
  "database_path",
  "settings_path",
  "root",
  "path",
  "file_path",
  "filepath",
  "source_file",
]);

const DIAGNOSTIC_SECRET_KEY_PATTERN =
  /(token|secret|password|authorization|api[_-]?key|bearer|cookie|set-cookie)/i;
const DIAGNOSTIC_MACHINE_KEY_PATTERN = /^(machine_name|hostname|computername)$/i;
const DIAGNOSTIC_USER_KEY_PATTERN = /^(username|user_name)$/i;

const SECRET_MARKER_PATTERN =
  /(authorization:\s*bearer\s+|bearer\s+|access_token=|refresh_token=|api_key=|apikey=|token=|password=|secret=|client_secret=|x-api-key:\s*)[^\s"'&,;\])}]+/gi;

const LOCAL_PATH_PATTERN =
  /[A-Za-z]:[\\/][^"'\s,;)\]}<>`]+|\/(?:Users|home)\/[^/"'\s]+\/[^"'\s,;)\]}<>`]*/g;

export function sanitizeDiagnosticsValue(value: unknown, key = ""): unknown {
  if (DIAGNOSTIC_SECRET_KEY_PATTERN.test(key)) {
    return REDACTED_SECRET;
  }
  if (DIAGNOSTIC_MACHINE_KEY_PATTERN.test(key)) {
    return REDACTED_MACHINE;
  }
  if (DIAGNOSTIC_USER_KEY_PATTERN.test(key)) {
    return REDACTED_USER;
  }
  if (DIAGNOSTIC_PATH_KEYS.has(key)) {
    return REDACTED_LOCAL_PATH;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDiagnosticsValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeDiagnosticsValue(entryValue, entryKey),
      ]),
    );
  }
  if (typeof value === "string") {
    return value
      .replace(SECRET_MARKER_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED_SECRET}`)
      .replace(LOCAL_PATH_PATTERN, REDACTED_LOCAL_PATH);
  }
  return value;
}

export function sanitizeDiagnosticsLog(debugLog?: string): string | undefined {
  if (!debugLog?.trim()) return undefined;
  try {
    const parsed = JSON.parse(debugLog) as unknown;
    return JSON.stringify(sanitizeDiagnosticsValue(parsed), null, 2);
  } catch {
    return String(sanitizeDiagnosticsValue(debugLog));
  }
}

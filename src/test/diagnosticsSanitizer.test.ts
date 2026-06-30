import { describe, expect, test } from "vitest";
import { sanitizeDiagnosticsLog, sanitizeDiagnosticsValue } from "../utils/diagnosticsSanitizer";

describe("diagnostics sanitizer", () => {
  test("redacts secret keys and auth fragments", () => {
    const sanitized = sanitizeDiagnosticsValue({
      authorization: "Bearer secret-token",
      detail: "request failed with Authorization: Bearer raw-secret and token=query-secret",
    });

    const text = JSON.stringify(sanitized);
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("raw-secret");
    expect(text).not.toContain("query-secret");
    expect(text).toContain("<redacted secret>");
  });

  test("redacts local paths from diagnostic event fields", () => {
    const sanitized = sanitizeDiagnosticsLog(JSON.stringify({
      session: {
        database_path: "C:\\Users\\person\\AppData\\Local\\auditaur\\telemetry.sqlite",
      },
      frontend_errors: [{
        detail: "at C:\\Users\\person\\project\\src\\App.tsx and /Users/person/project/file.ts",
      }],
    }));

    expect(sanitized).toBeDefined();
    expect(sanitized).not.toContain("Users\\\\person");
    expect(sanitized).not.toContain("/Users/person");
    expect(sanitized).toContain("<redacted local path>");
  });

  test("does not expose machine_name when sanitizing legacy feedback system info", () => {
    const sanitized = sanitizeDiagnosticsValue({
      system_info: {
        app_version: "1.0.0",
        os: "windows",
        os_family: "windows",
        arch: "x86_64",
        machine_name: "DEV-MACHINE",
      },
    });

    expect(JSON.stringify(sanitized)).not.toContain("DEV-MACHINE");
    expect(JSON.stringify(sanitized)).toContain("<redacted machine>");
  });
});

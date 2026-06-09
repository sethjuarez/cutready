import { initAuditaur, type AuditaurClient } from "@auditaur/api";
import { invoke as rawInvoke } from "@tauri-apps/api/core";

let client: AuditaurClient | null = null;
let initPromise: Promise<AuditaurClient | null> | null = null;

export interface DiagnosticsPolicy {
  enabled: boolean;
  release_build: boolean;
  source: string;
  startup_flag_enabled: boolean;
  auditaur_flag_enabled: boolean;
  persisted_setting_enabled: boolean | null;
  settings_path: string | null;
}

export function getAuditaurClient() {
  return client;
}

export async function getDiagnosticsPolicy(): Promise<DiagnosticsPolicy> {
  return rawInvoke<DiagnosticsPolicy>("get_diagnostics_policy");
}

export function initializeAuditaur() {
  if (initPromise) return initPromise;

  const originalWarn = console.warn.bind(console);
  initPromise = getDiagnosticsPolicy().then((policy) => {
    if (!policy.enabled) return null;
    return initAuditaur({
      serviceName: "cutready-frontend",
      instrumentConsole: true,
      instrumentErrors: true,
      instrumentTauriInvoke: true,
      instrumentTauriEvents: true,
      captureFullPayloads: false,
      batchIntervalMs: 1000,
      onExportError(failure) {
        originalWarn("Auditaur export failed", failure.error);
      },
    });
  })
    .then((auditaur) => {
      client = auditaur;
      return auditaur;
    })
    .catch((error) => {
      originalWarn("Auditaur initialization failed", error);
      initPromise = null;
      return null;
    });

  return initPromise;
}

export function flushAuditaur() {
  return client?.flush() ?? Promise.resolve();
}

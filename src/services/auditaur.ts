import { initAuditaur, type AuditaurClient } from "@auditaur/api";

let client: AuditaurClient | null = null;
let initPromise: Promise<AuditaurClient | null> | null = null;

export function getAuditaurClient() {
  return client;
}

export function initializeAuditaur() {
  if (initPromise) return initPromise;

  const originalWarn = console.warn.bind(console);
  initPromise = initAuditaur({
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

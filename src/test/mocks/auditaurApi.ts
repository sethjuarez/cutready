export type AuditaurClient = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  emit(event: string, payload?: unknown): Promise<void>;
  emitTo(target: string, event: string, payload?: unknown): Promise<void>;
  listen<T>(event: string, handler: (event: { event: string; id: number; payload: T }) => void): Promise<() => void>;
  createOpenTelemetrySpanExporter(): unknown;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
};

export type AuditaurFrontendConfig = {
  serviceName: string;
};

export async function initAuditaur(_config: AuditaurFrontendConfig): Promise<AuditaurClient> {
  return {
    invoke: async () => {
      throw new Error("Auditaur invoke mock should not be called outside a Tauri runtime");
    },
    emit: async () => {},
    emitTo: async () => {},
    listen: async () => () => {},
    createOpenTelemetrySpanExporter: () => ({}),
    flush: async () => {},
    shutdown: async () => {},
  };
}

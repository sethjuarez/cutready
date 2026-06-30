import {
  Channel,
  convertFileSrc,
  invoke as rawInvoke,
  type InvokeArgs,
  type InvokeOptions,
} from "@tauri-apps/api/core";
import {
  emit as rawEmit,
  emitTo as rawEmitTo,
  listen as rawListen,
  once as rawOnce,
  type EventCallback,
  type EventName,
  type EventTarget,
  type Options,
  type UnlistenFn,
} from "@tauri-apps/api/event";
import { getAuditaurClient, initializeAuditaur } from "./auditaur";

type AuditaurInvokeArgs = Record<string, unknown>;

const SENSITIVE_INVOKE_COMMANDS = new Set([
  "azure_browser_auth_complete",
  "azure_device_code_poll",
  "azure_token_refresh",
  "save_feedback",
]);

function isTauriRuntime() {
  return typeof window !== "undefined" && Boolean((window as any).__TAURI_INTERNALS__);
}

function canUseAuditaurInvoke(args?: InvokeArgs, options?: InvokeOptions): args is AuditaurInvokeArgs | undefined {
  if (options) return false;
  if (!args) return true;
  return !Array.isArray(args) && !(args instanceof ArrayBuffer) && !(args instanceof Uint8Array);
}

async function getAuditaur() {
  if (!isTauriRuntime()) return null;
  return getAuditaurClient() ?? await initializeAuditaur();
}

export async function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  if (SENSITIVE_INVOKE_COMMANDS.has(cmd)) {
    return options ? rawInvoke<T>(cmd, args, options) : rawInvoke<T>(cmd, args);
  }

  if (!canUseAuditaurInvoke(args, options)) {
    return options ? rawInvoke<T>(cmd, args, options) : rawInvoke<T>(cmd, args);
  }

  const auditaur = await getAuditaur();
  if (!auditaur) return args === undefined ? rawInvoke<T>(cmd) : rawInvoke<T>(cmd, args);
  return auditaur.invoke<T>(cmd, args);
}

export async function listen<T>(
  event: EventName,
  handler: EventCallback<T>,
  options?: Options,
): Promise<UnlistenFn> {
  if (options) return rawListen<T>(event, handler, options);

  const auditaur = await getAuditaur();
  if (!auditaur) return rawListen<T>(event, handler);
  return auditaur.listen<T>(event, handler);
}

export async function once<T>(
  event: EventName,
  handler: EventCallback<T>,
  options?: Options,
): Promise<UnlistenFn> {
  if (options) return rawOnce<T>(event, handler, options);

  let unlisten: UnlistenFn | null = null;
  unlisten = await listen<T>(event, (payload) => {
    unlisten?.();
    handler(payload);
  });
  return unlisten;
}

export async function emit<T>(event: string, payload?: T): Promise<void> {
  const auditaur = await getAuditaur();
  if (!auditaur) return payload === undefined ? rawEmit<T>(event) : rawEmit<T>(event, payload);
  return auditaur.emit(event, payload);
}

export async function emitTo<T>(
  target: EventTarget | string,
  event: string,
  payload?: T,
): Promise<void> {
  if (typeof target !== "string") return rawEmitTo<T>(target, event, payload);

  const auditaur = await getAuditaur();
  if (!auditaur) return payload === undefined ? rawEmitTo<T>(target, event) : rawEmitTo<T>(target, event, payload);
  return auditaur.emitTo(target, event, payload);
}

export { Channel, convertFileSrc };

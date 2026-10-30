import type {
  AuditaurFrontendConfig,
  AuditaurRedactConsole,
  AuditaurRedactErrorMessage,
  AuditaurRedactPayload,
} from "@auditaur/api";

// What diagnostics may record about IPC. Two layers:
//
// 1. Bypass: commands carrying credentials, identity, chat transcripts, agent
//    runs, or agent memory skip instrumentation entirely (no span, payload, or
//    error message). Backend #[auditaur_command] spans use skip_all, so only the
//    frontend side needs this list.
// 2. Redaction: everything else is recorded, but values under REDACT_KEYS
//    (on top of Auditaur's credential defaults) are replaced in the webview.
//    redactTelemetryPayload and redactTelemetryErrorMessage also omit payloads
//    and error messages from bypassed commands, so each layer covers the other.
//
// Keep the bypass list as defense in depth: it also hides command timing and
// outcome. Console bodies and uncaught errors go through redactTelemetryConsole
// and redactTelemetryErrorMessage.
export const SENSITIVE_INVOKE_COMMANDS = new Set([
  "agent_chat",
  "agent_chat_with_tools",
  "get_agent_run",
  "get_agent_state_database_preview",
  "get_chat_session",
  "get_memory_context",
  "list_agent_runs",
  "list_chat_sessions",
  "push_pending_chat_message",
  "save_chat_session",
  "update_chat_summary",
  "update_memory",
  "azure_browser_auth_complete",
  "azure_device_code_poll",
  "azure_token_refresh",
  "clear_contributor_identity",
  "get_contributor_identity",
  "github_device_code_poll",
  "github_device_code_start",
  "list_azure_ai_resources",
  "list_azure_subscriptions",
  "list_foundry_projects",
  "list_models",
  "read_narration_asset",
  "save_feedback",
  "save_narration_recording",
  "set_contributor_identity",
  "synthesize_narration_recording",
]);
// Note commands are generic, but promoted chat artifacts (.cv) hold transcripts.
const CHAT_ARTIFACT_NOTE_COMMANDS = new Set(["get_note", "update_note"]);
const SENSITIVE_TAURI_EVENTS = new Set(["agent-event"]);

// Matched case-insensitively at any depth. Auditaur's defaults cover snake_case
// credentials; these add camelCase credentials, identity (history entries carry
// author/saved_by), chat or prompt content, and authored project content.
export const REDACT_KEYS = [
  "accessToken",
  "refreshToken",
  "idToken",
  "clientSecret",
  "deviceCode",
  "device_code",
  "userCode",
  "user_code",
  "email",
  "author",
  "saved_by",
  "promoted_by",
  "transcript",
  "messages",
  "prompt",
  "systemPrompt",
  // Authored project content (notes, sketches, storyboards, visuals, narration).
  "content",
  "description",
  "narrative",
  "demo_actions",
  "design_plan",
  "rationale",
  "visual",
  "document",
  "text",
  "source_text",
  "ssml",
];

export const OMITTED_PAYLOAD = "[omitted]";

export function isSensitiveInvokeCommand(command: string, args?: unknown) {
  if (SENSITIVE_INVOKE_COMMANDS.has(command)) return true;
  if (!CHAT_ARTIFACT_NOTE_COMMANDS.has(command) || !args || typeof args !== "object") return false;
  const path = (args as Record<string, unknown>).relativePath;
  return typeof path === "string" && path.toLowerCase().endsWith(".cv");
}

export function isSensitiveTauriEvent(event: string) {
  return SENSITIVE_TAURI_EVENTS.has(event);
}

export const redactTelemetryPayload: AuditaurRedactPayload = (payload, { kind, name }) => {
  if (kind === "eventPayload") return isSensitiveTauriEvent(name) ? OMITTED_PAYLOAD : payload;
  if (SENSITIVE_INVOKE_COMMANDS.has(name)) return OMITTED_PAYLOAD;
  // A note result can't be tied back to its path, so omit every note body.
  if (CHAT_ARTIFACT_NOTE_COMMANDS.has(name) && (kind === "invokeResult" || isSensitiveInvokeCommand(name, payload))) {
    return OMITTED_PAYLOAD;
  }
  return payload;
};

// Git/Draftline errors from ordinary commands can echo the contributor's email.
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*/g;
const scrubEmails = (text: string) => text.replace(EMAIL_PATTERN, "[email]");

export const redactTelemetryErrorMessage: AuditaurRedactErrorMessage = (message, { name }) =>
  isSensitiveInvokeCommand(name) || isSensitiveTauriEvent(name) ? OMITTED_PAYLOAD : scrubEmails(message);

// Console bodies carry no command name, so sensitive areas are matched by their log text:
// chat, agent memory, auth/credentials, feedback, and contributor identity.
const SENSITIVE_CONSOLE_PATTERN =
  /\[(?:chat|auth|secrets|feedback)\]|chat (?:session|run|promotion)|pending message|memor(?:y|ies)|contributor identity|oauth/i;

export const redactTelemetryConsole: AuditaurRedactConsole = (body) =>
  SENSITIVE_CONSOLE_PATTERN.test(body) ? OMITTED_PAYLOAD : scrubEmails(body);

// Shared by initAuditaur and the redaction tests so both see the same policy.
export const TELEMETRY_REDACTION = {
  captureFullPayloads: false,
  redactKeys: REDACT_KEYS,
  redactPayload: redactTelemetryPayload,
  redactErrorMessage: redactTelemetryErrorMessage,
  redactConsole: redactTelemetryConsole,
} satisfies Partial<AuditaurFrontendConfig>;

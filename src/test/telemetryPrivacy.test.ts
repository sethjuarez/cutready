import { afterEach, describe, expect, test, vi } from "vitest";
import { isSensitiveInvokeCommand, isSensitiveTauriEvent } from "../services/tauri";
import { OMITTED_PAYLOAD, REDACT_KEYS, TELEMETRY_REDACTION, redactTelemetryPayload } from "../services/telemetryPolicy";
import { recordActivityEntries } from "../services/telemetry";

// The real package, not the vitest alias mock, so these run Auditaur's recording path.
const auditaur = await vi.importActual<typeof import("../../node_modules/@auditaur/api/dist/index.js")>(
  "../../node_modules/@auditaur/api/dist/index.js",
);
const recorded = (kind: "invokeArgs" | "invokeResult" | "eventPayload", name: string, value: unknown) =>
  JSON.stringify(auditaur.recordedPayload(TELEMETRY_REDACTION, kind, name, value));
const recordedError = (name: string, error: unknown) => auditaur.recordedErrorMessage(TELEMETRY_REDACTION, name, error);

describe("recorded telemetry (Auditaur helpers)", () => {
  test("identity, chat, and credential payloads are omitted", () => {
    for (const [kind, name, value] of [
      ["invokeArgs", "set_contributor_identity", { name: "Ada Lovelace", email: "ada@example.com" }],
      ["invokeResult", "get_contributor_identity", { name: "Ada Lovelace", email: "ada@example.com" }],
      ["invokeArgs", "agent_chat_with_tools", { messages: [{ role: "user", content: "secret plan" }] }],
      ["invokeResult", "get_chat_session", { title: "secret plan" }],
      ["invokeResult", "github_device_code_start", { user_code: "ABCD-1234", verification_uri: "x" }],
      ["invokeArgs", "azure_token_refresh", { refreshToken: "rt-secret" }],
      ["eventPayload", "agent-event", { delta: "secret plan" }],
    ] as const) {
      const shown = recorded(kind, name, value);
      expect(shown).not.toMatch(/Ada|ada@|secret plan|ABCD-1234|rt-secret/);
    }
  });

  test("other payloads keep metadata but redact identity and authored content", () => {
    const shown = recorded("invokeResult", "list_snapshots", [
      { id: "abc123", message: "Save", author: "Ada Lovelace", email: "ada@example.com" },
    ]);
    expect(shown).toContain("abc123");
    expect(shown).not.toMatch(/Ada|ada@/);
    expect(recorded("invokeArgs", "update_note", { relativePath: "plan.md", content: "secret plan" })).not.toContain("secret plan");
    expect(recorded("invokeArgs", "update_note", { relativePath: "chat-artifacts/a.cv", content: "x" })).not.toContain("a.cv");
  });

  test("identity, chat, and credential error messages are omitted", () => {
    for (const name of [
      "set_contributor_identity",
      "get_contributor_identity",
      "agent_chat_with_tools",
      "save_chat_session",
      "update_memory",
      "github_device_code_poll",
      "azure_token_refresh",
      "agent-event",
    ]) {
      expect(recordedError(name, "invalid identity ada@example.com: secret plan")).toBe(OMITTED_PAYLOAD);
    }
  });

  test("other error messages are kept, with object errors key-redacted", () => {
    expect(recordedError("list_snapshots", "repository not found")).toBe("repository not found");
    expect(recordedError("save_snapshot", "unable to auto-detect email address (got 'ada@host.(none)')")).toBe(
      "unable to auto-detect email address (got '[email].(none)')",
    );
    const shown = recordedError("update_note", { message: "write failed", content: "secret plan" });
    expect(shown).toContain("write failed");
    expect(shown).not.toContain("secret plan");
  });
});

describe("telemetry privacy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("agent chat bypasses IPC result instrumentation", () => {
    expect(isSensitiveInvokeCommand("agent_chat_with_tools")).toBe(true);
  });

  test("chat transcript, agent run, and memory commands bypass IPC instrumentation", () => {
    for (const cmd of [
      "agent_chat",
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
    ]) {
      expect(isSensitiveInvokeCommand(cmd)).toBe(true);
    }
  });

  test("contributor identity commands bypass IPC instrumentation", () => {
    for (const cmd of ["get_contributor_identity", "set_contributor_identity", "clear_contributor_identity"]) {
      expect(isSensitiveInvokeCommand(cmd)).toBe(true);
    }
  });

  test("credential-bearing provider and device-code commands bypass IPC instrumentation", () => {
    for (const cmd of [
      "github_device_code_start",
      "list_azure_ai_resources",
      "list_azure_subscriptions",
      "list_foundry_projects",
      "list_models",
      "synthesize_narration_recording",
    ]) {
      expect(isSensitiveInvokeCommand(cmd)).toBe(true);
    }
  });

  test("promoted chat artifacts bypass note IPC instrumentation; ordinary notes do not", () => {
    expect(isSensitiveInvokeCommand("update_note", { relativePath: "chat-artifacts/run.cv", content: "x" })).toBe(true);
    expect(isSensitiveInvokeCommand("get_note", { relativePath: "chat-artifacts/Run.CV" })).toBe(true);
    expect(isSensitiveInvokeCommand("update_note", { relativePath: "planning.md", content: "x" })).toBe(false);
    expect(isSensitiveInvokeCommand("get_note")).toBe(false);
  });

  test("agent events bypass payload instrumentation", () => {
    expect(isSensitiveTauriEvent("agent-event")).toBe(true);
  });

  test("redaction hook omits payloads from bypassed commands, note bodies, and agent events", () => {
    expect(redactTelemetryPayload({ name: "Ada" }, { kind: "invokeArgs", name: "set_contributor_identity" })).toBe(OMITTED_PAYLOAD);
    expect(redactTelemetryPayload([{ role: "user" }], { kind: "invokeResult", name: "save_chat_session" })).toBe(OMITTED_PAYLOAD);
    expect(redactTelemetryPayload({ relativePath: "a.cv", content: "x" }, { kind: "invokeArgs", name: "update_note" })).toBe(OMITTED_PAYLOAD);
    expect(redactTelemetryPayload("note body", { kind: "invokeResult", name: "get_note" })).toBe(OMITTED_PAYLOAD);
    expect(redactTelemetryPayload({ delta: "hi" }, { kind: "eventPayload", name: "agent-event" })).toBe(OMITTED_PAYLOAD);
    const args = { relativePath: "planning.md" };
    expect(redactTelemetryPayload(args, { kind: "invokeArgs", name: "get_note" })).toBe(args);
    expect(redactTelemetryPayload(args, { kind: "invokeArgs", name: "list_snapshots" })).toBe(args);
  });

  test("redaction keys cover identity, chat content, and camelCase credentials beyond Auditaur defaults", () => {
    const keys = new Set(REDACT_KEYS.map((key) => key.toLowerCase()));
    for (const key of ["email", "author", "saved_by", "messages", "prompt", "accesstoken", "refreshtoken", "usercode", "content", "narrative", "demo_actions", "description"]) {
      expect(keys.has(key)).toBe(true);
    }
  });

  test("activity telemetry records metadata without the activity body", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sensitiveContent = "private project content";

    recordActivityEntries([{
      id: "activity-1",
      timestamp: new Date("2026-07-23T00:00:00Z"),
      source: "result read_note",
      content: sensitiveContent,
      level: "success",
    }]);

    expect(info).toHaveBeenCalledOnce();
    const payload = info.mock.calls[0][0];
    expect(payload).toMatchObject({
      type: "cutready.activity",
      source: "result read_note",
      contentChars: sensitiveContent.length,
      level: "success",
    });
    expect(JSON.stringify(payload)).not.toContain(sensitiveContent);
  });
});

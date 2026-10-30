import { afterEach, describe, expect, test, vi } from "vitest";
import { isSensitiveInvokeCommand, isSensitiveTauriEvent } from "../services/tauri";
import { OMITTED_PAYLOAD, REDACT_KEYS, redactTelemetryPayload } from "../services/telemetryPolicy";
import { recordActivityEntries } from "../services/telemetry";

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

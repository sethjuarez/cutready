import { afterEach, describe, expect, test, vi } from "vitest";
import { isSensitiveInvokeCommand, isSensitiveTauriEvent } from "../services/tauri";
import { recordActivityEntries } from "../services/telemetry";

describe("telemetry privacy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("agent chat bypasses IPC result instrumentation", () => {
    expect(isSensitiveInvokeCommand("agent_chat_with_tools")).toBe(true);
  });

  test("agent events bypass payload instrumentation", () => {
    expect(isSensitiveTauriEvent("agent-event")).toBe(true);
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

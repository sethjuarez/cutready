import { describe, expect, it } from "vitest";
import { errorMessage, MAX_ACTIVITY_ENTRIES, useAppStore } from "../stores/appStore";

describe("errorMessage", () => {
  it("uses the message field from structured command errors", () => {
    expect(errorMessage({
      code: "sync_needs_merge",
      message: "remote has incoming changes that need an explicit merge plan",
      details: { ahead: 7, behind: 2 },
    })).toBe("remote has incoming changes that need an explicit merge plan");
  });
});

describe("activity log", () => {
  it("keeps a bounded rolling window of the newest entries", () => {
    useAppStore.setState({ activityLog: [] });
    const entry = (n: number) => ({ id: `e${n}`, timestamp: new Date(0), source: "t", content: `${n}`, level: "info" as const });
    const { addActivityEntries } = useAppStore.getState();
    addActivityEntries(Array.from({ length: MAX_ACTIVITY_ENTRIES }, (_, n) => entry(n)));
    addActivityEntries([entry(MAX_ACTIVITY_ENTRIES), entry(MAX_ACTIVITY_ENTRIES + 1)]);

    const log = useAppStore.getState().activityLog;
    expect(log).toHaveLength(MAX_ACTIVITY_ENTRIES);
    expect(log[0].id).toBe("e2");
    expect(log[log.length - 1].id).toBe(`e${MAX_ACTIVITY_ENTRIES + 1}`);
  });
});

describe("chat persistence", () => {
  it("keeps messages attached to their database-backed session", () => {
    useAppStore.setState({
      chatMessages: [],
      chatSessionPath: "session-123",
    });

    useAppStore.getState().setChatMessages([{ role: "user", content: "Plan the demo" }]);

    expect(useAppStore.getState().chatMessages).toEqual([{ role: "user", content: "Plan the demo" }]);
    expect(useAppStore.getState().chatSessionPath).toBe("session-123");
  });

  it("restores a stored transcript into the active conversation", () => {
    const transcript = [
      { role: "user", content: "Open the saved conversation" },
      { role: "assistant", content: "Restored." },
    ];

    useAppStore.getState().restoreChatSession("restored-session", transcript);

    expect(useAppStore.getState().chatSessionPath).toBe("restored-session");
    expect(useAppStore.getState().chatMessages).toEqual(transcript);
  });
});

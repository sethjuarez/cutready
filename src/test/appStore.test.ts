import { describe, expect, it } from "vitest";
import { errorMessage, MAX_ACTIVITY_ENTRIES, useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";

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
    useChatStore.setState({
      chatMessages: [],
      chatSessionPath: "session-123",
    });

    useChatStore.getState().setChatMessages([{ role: "user", content: "Plan the demo" }]);

    expect(useChatStore.getState().chatMessages).toEqual([{ role: "user", content: "Plan the demo" }]);
    expect(useChatStore.getState().chatSessionPath).toBe("session-123");
  });

  it("keeps a send error when the failed turn's messages are kept", () => {
    useChatStore.setState({ chatMessages: [], chatError: null });

    useChatStore.getState().setChatError("Provider returned 500");
    useChatStore.getState().setChatMessages([{ role: "user", content: "Plan the demo" }]);

    expect(useChatStore.getState().chatError).toBe("Provider returned 500");
  });

  it("restores a stored transcript into the active conversation", () => {
    const transcript = [
      { role: "user", content: "Open the saved conversation" },
      { role: "assistant", content: "Restored." },
    ];

    useChatStore.getState().restoreChatSession("restored-session", transcript);

    expect(useChatStore.getState().chatSessionPath).toBe("restored-session");
    expect(useChatStore.getState().chatMessages).toEqual(transcript);
  });
});

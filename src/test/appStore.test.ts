import { describe, expect, it } from "vitest";
import { errorMessage, useAppStore } from "../stores/appStore";

describe("errorMessage", () => {
  it("uses the message field from structured command errors", () => {
    expect(errorMessage({
      code: "sync_needs_merge",
      message: "remote has incoming changes that need an explicit merge plan",
      details: { ahead: 7, behind: 2 },
    })).toBe("remote has incoming changes that need an explicit merge plan");
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

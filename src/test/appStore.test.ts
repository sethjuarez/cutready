import { describe, expect, it } from "vitest";
import { createLocalChatSessionPath, errorMessage } from "../stores/appStore";

describe("createLocalChatSessionPath", () => {
  it("creates a local git-state chat URI instead of a project .chats path", () => {
    const path = createLocalChatSessionPath(new Date("2026-06-17T05:26:00Z"));

    expect(path).toMatch(/^cutready:\/\/legacy-chats\/chat-2026-06-17T05-26-00Z-[a-f0-9-]+\.chat$/);
    expect(path).not.toContain(".chats/");
  });

  describe("errorMessage", () => {
    it("uses the message field from structured command errors", () => {
      expect(errorMessage({
        code: "sync_needs_merge",
        message: "remote has incoming changes that need an explicit merge plan",
        details: { ahead: 7, behind: 2 },
      })).toBe("remote has incoming changes that need an explicit merge plan");
    });
  });
});

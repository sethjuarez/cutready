import { describe, expect, it, vi } from "vitest";
import { reconcileMessagesForDisplay } from "../components/ChatPanel";
import type { ChatMessage } from "../types/sketch";

describe("reconcileMessagesForDisplay", () => {
  it("restores earlier user messages when backend injects referenced documents", () => {
    const displayMessages: ChatMessage[] = [
      { role: "user", content: "Please use this note.\n[References: @note:ppt-notes.md]" },
      { role: "assistant", content: "Sure." },
      { role: "user", content: "Now summarize it." },
    ];
    const backendMessages: ChatMessage[] = [
      { role: "system", content: "system prompt" },
      {
        role: "user",
        content: `Please use this note.
<referenced_document name="ppt-notes" content_type="text/markdown">
[Truncated at 15000 chars]
secret backend-only reference content
</referenced_document>`,
      },
      { role: "assistant", content: "Sure." },
      { role: "user", content: "Now summarize it." },
      { role: "assistant", content: "Summary." },
    ];
    const logger = vi.fn();

    const reconciled = reconcileMessagesForDisplay(backendMessages, displayMessages, { logger });

    expect(reconciled.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(reconciled[0].content).toBe(displayMessages[0].content);
    expect(String(reconciled[0].content)).not.toContain("<referenced_document");
    expect(String(reconciled[0].content)).not.toContain("[Truncated at 15000 chars]");
    expect(reconciled[2].content).toBe("Now summarize it.");
    expect(logger).toHaveBeenCalledWith("Restored display-safe user chat content", expect.objectContaining({
      index: 0,
      leakedReferencePayload: true,
      hadDisplayUser: true,
    }));
  });

  it("removes backend web content from user bubbles when no display copy exists", () => {
    const backendMessages: ChatMessage[] = [
      {
        role: "user",
        content: `Check this.

[Web Content: https://azure.microsoft.com/en-us/pricing/purchase-options/azure-account/search]
backend-only scraped page text`,
      },
    ];

    const reconciled = reconcileMessagesForDisplay(backendMessages, []);

    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].content).toBe("Check this.");
  });

  it("drops the triggering user message for silent sends after restoring display content", () => {
    const displayMessages: ChatMessage[] = [
      { role: "user", content: "Improve row 1." },
    ];
    const backendMessages: ChatMessage[] = [
      { role: "user", content: "<referenced_document name=\"x\" content_type=\"text/plain\">hidden</referenced_document>" },
      { role: "assistant", content: "Done." },
    ];

    const reconciled = reconcileMessagesForDisplay(backendMessages, displayMessages, { silent: true });

    expect(reconciled.map((m) => m.role)).toEqual(["assistant"]);
  });

  it("drops extra backend user messages that duplicate the assistant response", () => {
    const logger = vi.fn();
    const backendMessages: ChatMessage[] = [
      { role: "user", content: "Original question" },
      { role: "user", content: "This is the assistant answer." },
      { role: "assistant", content: "This is the assistant answer." },
    ];

    const reconciled = reconcileMessagesForDisplay(
      backendMessages,
      [{ role: "user", content: "Original question" }],
      { assistantResponse: "This is the assistant answer.", logger },
    );

    expect(reconciled.map((m) => [m.role, m.content])).toEqual([
      ["user", "Original question"],
      ["assistant", "This is the assistant answer."],
    ]);
    expect(logger).toHaveBeenCalledWith(
      "Dropped backend user message that duplicated assistant response",
      expect.objectContaining({ index: 1 }),
    );
  });
});

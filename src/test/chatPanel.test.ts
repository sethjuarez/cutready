import { describe, expect, it, vi } from "vitest";
import {
  applyStreamingDeltaReset,
  askModeApprovedSystemInstruction,
  askModeCancelledMessage,
  buildChatWorkingNotes,
  canUseChatMutationTools,
  cancelAgentChatRun,
  chatSessionTitle,
  describeToolCall,
  fetchWebReferenceContent,
  resolveWebReferenceContent,
  extractInlineToolActivity,
  isChatScrolledNearBottom,
  reconcileMessagesForDisplay,
  scrollChatContainerToBottom,
  shouldRequestChatMutationApproval,
} from "../components/ChatPanel";
import type { ChatMessage } from "../types/sketch";
import {
  agentRunEventLabel,
  agentRunProviderLabel,
  agentRunStatusLabel,
} from "../components/AgentRunInspector";
import { sessionSourceLabel, sessionSourcePathLabel } from "../components/SessionHistoryPanel";

describe("describeToolCall", () => {
  it("summarizes planning row updates without exposing raw arguments", () => {
    expect(describeToolCall(
      "update_planning_row",
      JSON.stringify({ path: "sketches/intro.sk", row_number: 3, narrative: "Private draft" }),
    )).toBe("Updating planning row 3 in intro.sk");
  });

  describe("cancelAgentChatRun", () => {
    it("uses the active client run ID when requesting cancellation", async () => {
      const cancel = vi.fn().mockResolvedValue(undefined);

      await cancelAgentChatRun(42, cancel);

      expect(cancel).toHaveBeenCalledExactlyOnceWith("42");
    });
  });
});

describe("fetchWebReferenceContent", () => {
  it("deduplicates concurrent fetches for the same URL", async () => {
    const url = "https://example.test/dedupe";
    const fetcher = vi.fn().mockResolvedValue("reference content");

    const [first, second] = await Promise.all([
      fetchWebReferenceContent(url, fetcher),
      fetchWebReferenceContent(url, fetcher),
    ]);

    expect(first).toBe("reference content");
    expect(second).toBe("reference content");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fetches a URL again for a later send", async () => {
    const url = "https://example.test/refresh";
    const fetcher = vi.fn().mockResolvedValue("reference content");

    await fetchWebReferenceContent(url, fetcher);
    await fetchWebReferenceContent(url, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("resolveWebReferenceContent", () => {
  it("fetches only the web references attached to the submitted turn", async () => {
    const fetcher = vi.fn().mockResolvedValue("reference content");

    const resolved = await resolveWebReferenceContent([
      { path: "https://example.test/attached" },
    ], fetcher);

    expect(fetcher).toHaveBeenCalledExactlyOnceWith("https://example.test/attached");
    expect(resolved).toEqual([{
      path: "https://example.test/attached",
      webContent: "reference content",
      webStatus: "ready",
    }]);
  });

  it("keeps a failed reference out of context while preserving the submitted URL", async () => {
    const resolved = await resolveWebReferenceContent([
      { path: "https://example.test/unavailable" },
    ], vi.fn().mockRejectedValue(new Error("offline")));

    expect(resolved).toEqual([{
      path: "https://example.test/unavailable",
      webStatus: "error",
    }]);
  });
});

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

  it("preserves CutReady assistant metadata across backend reconciliation", () => {
    const displayMessages: ChatMessage[] = [
      { role: "user", content: "Question" },
      {
        role: "assistant",
        content: "Answer",
        cutready: { workingNotes: { drafts: ["I will inspect this first."] } },
      },
    ];
    const backendMessages: ChatMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "Question" },
      { role: "assistant", content: "Answer" },
    ];

    const reconciled = reconcileMessagesForDisplay(backendMessages, displayMessages);

    expect(reconciled[1].cutready?.workingNotes?.drafts).toEqual(["I will inspect this first."]);
  });
});

describe("isChatScrolledNearBottom", () => {
  it("treats positions within the threshold as following the bottom", () => {
    expect(isChatScrolledNearBottom({
      scrollHeight: 1_000,
      scrollTop: 452,
      clientHeight: 500,
    } satisfies Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">)).toBe(true);
  });

  it("detects when the user has intentionally scrolled away from the bottom", () => {
    expect(isChatScrolledNearBottom({
      scrollHeight: 1_000,
      scrollTop: 300,
      clientHeight: 500,
    } satisfies Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">)).toBe(false);
  });
});

describe("scrollChatContainerToBottom", () => {
  it("sets the scroll container to the bottom when the chat body is mounted", () => {
    const container = document.createElement("div");
    const endMarker = document.createElement("div");
    const scrollIntoView = vi.fn();
    endMarker.scrollIntoView = scrollIntoView;
    Object.defineProperty(container, "scrollHeight", { value: 1_500, configurable: true });

    const didScroll = scrollChatContainerToBottom(container, endMarker);

    expect(didScroll).toBe(true);
    expect(container.scrollTop).toBe(1_500);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto" });
  });

  it("does not mark scrolling as complete before the chat body is mounted", () => {
    expect(scrollChatContainerToBottom(null, document.createElement("div"))).toBe(false);
    expect(scrollChatContainerToBottom(document.createElement("div"), null)).toBe(false);
  });
});

describe("applyStreamingDeltaReset", () => {
  it("clears the next-turn buffer and captures the reset draft", () => {
    expect(applyStreamingDeltaReset({
      buffer: "I will check the sketches",
      visible: "I will check the sketches",
      drafts: [],
    })).toEqual({
      buffer: "",
      visible: "I will check the sketches",
      drafts: ["I will check the sketches"],
    });
  });
});

describe("buildChatWorkingNotes", () => {
  it("omits empty notes", () => {
    expect(buildChatWorkingNotes({ drafts: ["  "], thinking: "  " })).toBeUndefined();
  });

  it("keeps draft and thinking artifacts for final rendering", () => {
    expect(buildChatWorkingNotes({
      drafts: [" I will inspect first. "],
      thinking: "Considering tool choice.",
    })).toEqual({
      drafts: ["I will inspect first."],
      thinking: "Considering tool choice.",
    });
  });

});

describe("Ask Mode chat mutation gating", () => {
  it("allows mutation tools in ask mode only after approval", () => {
    expect(shouldRequestChatMutationApproval("ask")).toBe(true);
    expect(shouldRequestChatMutationApproval("auto")).toBe(false);
    expect(canUseChatMutationTools("ask", false)).toBe(false);
    expect(canUseChatMutationTools("ask", true)).toBe(true);
    expect(canUseChatMutationTools("auto", false)).toBe(true);
    expect(canUseChatMutationTools("readonly", true)).toBe(false);
  });

  it("tells the model ask mode approval permits write tools for the current turn", () => {
    const instruction = askModeApprovedSystemInstruction();

    expect(instruction).toContain("Ask before applying");
    expect(instruction).toContain("approved mutation tools");
    expect(instruction).toContain("you may use write or mutation tools");
    expect(instruction).not.toContain("cannot use write");
  });

  it("explains where to change settings when ask mode approval is canceled", () => {
    const message = askModeCancelledMessage();

    expect(message).toContain("Ask Mode is active");
    expect(message).toContain("Settings > AI apply behavior");
    expect(message).toContain("Auto-apply AI changes");
  });
});

describe("extractInlineToolActivity", () => {
  it("pairs assistant tool calls with later tool results", () => {
    const activity = extractInlineToolActivity(
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            call_type: "function",
            function: { name: "read_sketch", arguments: "{\"path\":\"intro.sk\"}" },
          },
        ],
      },
      [
        { role: "tool", content: "{\"title\":\"Intro\"}", tool_call_id: "call-1" },
        { role: "assistant", content: "Done." },
      ],
    );

    expect(activity).toEqual([
      {
        id: "call-1",
        name: "read_sketch",
        arguments: "{\"path\":\"intro.sk\"}",
        result: "{\"title\":\"Intro\"}",
      },
    ]);
  });

  describe("chat session history helpers", () => {
    it("uses the first user turn as a stable, compact session title", () => {
      expect(chatSessionTitle([
        { role: "system", content: "Hidden prompt" },
        { role: "user", content: "  Refine   the opening scene\nfor launch. " },
        { role: "assistant", content: "Sure." },
      ])).toBe("Refine the opening scene for launch.");
    });

    it("identifies imported chats without conflating them with current chats", () => {
      expect(sessionSourceLabel("legacy_import")).toBe("Imported chat");
      expect(sessionSourceLabel("chat_panel")).toBe("Chat");
      expect(sessionSourcePathLabel(".git/cutready/legacy-chats/chat.chat")).toBe("Archived chats/chat.chat");
    });

    it("keeps imported chat labels free of implementation terminology", () => {
      expect(agentRunProviderLabel("legacy_chat")).toBe("Imported chat");
      expect(agentRunStatusLabel("imported_legacy")).toBe("Imported");
      expect(agentRunEventLabel("legacy_chat_message")).toBe("Imported chat message");
    });
  });

  it("keeps multiple tool calls ordered by the assistant request", () => {
    const activity = extractInlineToolActivity(
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            call_type: "function",
            function: { name: "read_sketch", arguments: "{\"path\":\"intro.sk\"}" },
          },
          {
            id: "call-2",
            call_type: "function",
            function: { name: "write_sketch", arguments: "{\"path\":\"intro.sk\"}" },
          },
        ],
      },
      [
        { role: "tool", content: "updated", tool_call_id: "call-2" },
        { role: "tool", content: "read", tool_call_id: "call-1" },
      ],
    );

    expect(activity.map((item) => [item.id, item.name, item.result])).toEqual([
      ["call-1", "read_sketch", "read"],
      ["call-2", "write_sketch", "updated"],
    ]);
  });
});

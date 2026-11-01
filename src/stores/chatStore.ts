// In-memory chat state (architecture v3 F8). Promoted chat artifacts (.cv
// documents in the sidebar and tabs) and the output panel's activity/debug logs
// stay in appStore. Other stores are read with getState() inside actions only.
import { create } from "zustand";
import { useAppStore } from "./appStore";
import type { ChatMessage } from "../types/sketch";

export interface ChatState {
  /** Messages in the current in-memory chat. */
  chatMessages: ChatMessage[];
  /** Current database-backed chat session ID; retained for workspace compatibility. */
  chatSessionPath: string | null;
  /** Whether the chat is waiting for a response. */
  chatLoading: boolean;
  /** Last chat error message. */
  chatError: string | null;
  /** Current unsent chat input text, shared between normal and focus mode. */
  chatInputDraft: string;
  /** Live assistant text currently streaming from the agent. */
  chatStreamingText: string;
  /** Live reasoning text currently streaming from the agent. */
  chatStreamingThinking: string;
  /** Live status text currently streaming from the agent. */
  chatStreamingStatus: string;
  /** Assistant drafts captured before tool-round resets. */
  chatStreamingDrafts: string[];
  /** A prompt queued from outside the chat (e.g. sparkle buttons). ChatPanel picks this up and sends it. */
  pendingChatPrompt: { text: string; silent?: boolean; agent?: string } | null;
  /** Whether chat is occupying the main work area as an intentional focus mode. */
  chatFocusMode: boolean;
}

export interface ChatActions {
  /** Set the current in-memory chat messages without changing its database session. */
  setChatMessages: (messages: ChatMessage[]) => void;
  /** Restore a database-backed conversation into the Chat tab. */
  restoreChatSession: (sessionId: string, messages: ChatMessage[]) => void;
  /** Start a new in-memory conversation. */
  newChatSession: () => void;
  /** Set chat loading state. */
  setChatLoading: (loading: boolean) => void;
  /** Set chat error. */
  setChatError: (error: string | null) => void;
  /** Set current unsent chat input text. */
  setChatInputDraft: (draft: string) => void;
  /** Update live streaming chat state. */
  setChatStreamingState: (state: Partial<Pick<ChatState, "chatStreamingText" | "chatStreamingThinking" | "chatStreamingStatus" | "chatStreamingDrafts">>) => void;
  /** Clear live streaming chat state. */
  resetChatStreaming: () => void;
  /** Queue a prompt to be sent by the chat panel. */
  sendChatPrompt: (prompt: string, opts?: { silent?: boolean; agent?: string }) => void;
  /** Enter or exit chat focus mode. */
  setChatFocusMode: (enabled: boolean) => void;
}

export type ChatStoreState = ChatState & ChatActions;

/** Chat state as it is at app start. */
export function initialChatState(): ChatState {
  return {
    chatMessages: [],
    chatSessionPath: null,
    chatLoading: false,
    chatError: null,
    chatInputDraft: "",
    chatStreamingText: "",
    chatStreamingThinking: "",
    chatStreamingStatus: "",
    chatStreamingDrafts: [],
    pendingChatPrompt: null,
    chatFocusMode: false,
  };
}

export const useChatStore = create<ChatStoreState>((set) => ({
  ...initialChatState(),

  setChatMessages: (messages) => {
    // Callers clear chatError explicitly (send, retry, dismiss, session switch); a failed
    // send sets the error and then keeps the user's message, so this must not wipe it.
    set({ chatMessages: messages });
  },

  restoreChatSession: (sessionId, messages) => {
    set({
      chatMessages: messages,
      chatSessionPath: sessionId,
      chatLoading: false,
      chatError: null,
      chatInputDraft: "",
    });
  },

  newChatSession: () => {
    set({
      chatMessages: [],
      chatSessionPath: null,
      chatLoading: false,
      chatError: null,
      chatInputDraft: "",
    });
    useAppStore.setState({ activityLog: [] });
    useAppStore.getState()._persistTabs();
  },

  setChatLoading: (loading) => set({ chatLoading: loading }),
  setChatError: (error) => set({ chatError: error }),
  setChatInputDraft: (draft) => set({ chatInputDraft: draft }),
  setChatStreamingState: (state) => set(state),
  resetChatStreaming: () => set({
    chatStreamingText: "",
    chatStreamingThinking: "",
    chatStreamingStatus: "",
    chatStreamingDrafts: [],
  }),
  sendChatPrompt: (prompt, opts) => set({ pendingChatPrompt: { text: prompt, silent: opts?.silent, agent: opts?.agent } }),
  setChatFocusMode: (enabled) => set({ chatFocusMode: enabled }),
}));

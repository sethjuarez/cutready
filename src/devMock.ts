/**
 * Dev-mode mock for Tauri IPC.
 * When running in browser (no __TAURI_INTERNALS__), this intercepts
 * invoke() calls and returns realistic mock data so the full UI
 * can be previewed without the Rust backend.
 *
 * Activated automatically by main.tsx in dev mode.
 */

import type { Sketch, SketchSummary, NoteSummary, StoryboardSummary } from "./types/sketch";
import type { ProjectView } from "./types/project";

const MOCK_PROJECT: ProjectView = {
  root: "C:/mock-project",
  name: "Demo Project",
};

const MOCK_SKETCH: Sketch = {
  title: "Demo Introduction",
  description: null,
  rows: [
    { time: "0:00-0:30", narrative: "Welcome and intro", demo_actions: "Show landing page", screenshot: null },
    { time: "0:30-1:00", narrative: "Feature overview", demo_actions: "Navigate to dashboard", screenshot: null },
    { time: "1:00-1:30", narrative: "Deep dive into search", demo_actions: "Type query and show results", screenshot: null },
  ],
  state: "draft",
  created_at: "2025-01-15T10:00:00Z",
  updated_at: "2025-01-15T12:00:00Z",
};

const MOCK_SKETCHES: SketchSummary[] = [
  { path: "sketches/demo-introduction.sk", title: "Demo Introduction", state: "draft", row_count: 3, created_at: "2025-01-15T10:00:00Z", updated_at: "2025-01-15T12:00:00Z" },
  { path: "sketches/feature-deep-dive.sk", title: "Feature Deep Dive", state: "draft", row_count: 5, created_at: "2025-01-14T09:00:00Z", updated_at: "2025-01-14T11:00:00Z" },
];

const MOCK_NOTES: NoteSummary[] = [
  { path: "notes/script-draft.md", title: "Script Draft", size: 2048, updated_at: "2025-01-15T11:00:00Z" },
  { path: "notes/research-notes.md", title: "Research Notes", size: 1024, updated_at: "2025-01-14T15:00:00Z" },
];

const MOCK_STORYBOARDS: StoryboardSummary[] = [
  { path: "storyboards/full-demo.sb", title: "Full Demo Flow", sketch_count: 3, created_at: "2025-01-15T09:00:00Z", updated_at: "2025-01-15T12:30:00Z" },
];

const MOCK_NOTE_CONTENT = `# Script Draft

## Introduction
Welcome to the demo! Today we'll walk through the key features of our platform.

## Key Talking Points
- Modern dashboard with real-time analytics
- Powerful search with natural language queries
- Seamless integrations with your existing tools

## Closing
Thank you for watching! Visit our docs for more.
`;

// Mock settings store (simulates tauri-plugin-store)
const mockSettingsStore: Record<string, unknown> = {
  aiProvider: "azure_openai",
  aiAuthMode: "api_key",
  aiEndpoint: "https://mock-endpoint.openai.azure.com",
  aiApiKey: "mock-api-key-for-preview",
  aiModel: "gpt-4o",
  aiTenantId: "",
  aiClientId: "",
  aiAccessToken: "",
  aiRefreshToken: "",
  audioDevice: "",
  outputDirectory: "",
  aiSelectedAgent: "planner",
  aiAgents: [],
};

/** Mock handler for Tauri invoke calls */
function mockInvoke(cmd: string, args?: Record<string, unknown>): unknown {
  switch (cmd) {
    case "open_project":
    case "get_project":
      return MOCK_PROJECT;
    case "list_recent_projects":
      return [{ path: "C:/mock-project", last_opened: new Date().toISOString() }];
    case "list_sketches":
      return MOCK_SKETCHES;
    case "read_sketch":
      return MOCK_SKETCH;
    case "save_sketch":
      return null;
    case "create_sketch":
      return "sketches/new-sketch.sk";
    case "delete_sketch":
      return null;
    case "list_notes":
      return MOCK_NOTES;
    case "read_note":
      return MOCK_NOTE_CONTENT;
    case "save_note":
      return null;
    case "create_note":
      return "notes/new-note.md";
    case "delete_note":
      return null;
    case "list_storyboards":
      return MOCK_STORYBOARDS;
    case "read_storyboard":
      return { title: "Full Demo Flow", description: "", items: [], created_at: "2025-01-15T09:00:00Z", updated_at: "2025-01-15T12:30:00Z" };
    case "create_storyboard":
      return "storyboards/new.sb";
    case "delete_storyboard":
      return null;
    case "list_versions":
      return [
        { id: "abc123", message: "Initial draft", timestamp: "2025-01-15T10:00:00Z", summary: "Created demo introduction" },
        { id: "def456", message: "Added feature section", timestamp: "2025-01-15T11:00:00Z", summary: "Added deep dive section" },
      ];
    case "list_timelines":
      return [{ name: "main", label: "main", is_active: true, snapshot_count: 2, color_index: 0 }];
    case "get_graph":
      return [];
    case "create_snapshot":
      return "new-snapshot-id";
    case "get_sidebar_order":
      return { storyboards: [], sketches: [], notes: [] };
    case "list_chat_sessions":
      return [];
    case "save_chat_session":
      return null;
    case "get_chat_session":
      return { title: "New Chat", messages: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    case "delete_chat_session":
      return null;
    case "list_models":
      return ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-35-turbo", "o1-preview"];
    case "agent_chat_with_tools": {
      // Simulate a delayed AI response with mock tool calls
      const userMsgs = (args?.messages as Array<{ role: string; content: string }>) || [];
      const lastUser = userMsgs.filter(m => m.role === "user").pop();
      const mockToolCall = {
        role: "assistant" as const,
        content: null,
        tool_calls: [{
          id: "mock_tc_1",
          type: "function",
          function: { name: "list_project_files", arguments: "{}" },
        }],
      };
      const mockToolResult = {
        role: "tool" as const,
        content: "sketches/intro.sk, notes/outline.md",
        tool_call_id: "mock_tc_1",
      };
      return {
        messages: [...userMsgs, mockToolCall, mockToolResult],
        response: `This is a mock response to: "${lastUser?.content?.substring(0, 50) || "your message"}"\n\nIn production, this would come from your configured AI provider. The chat UI is fully functional — try the @reference autocomplete, context picker, and model selector!`,
      };
    }
    case "push_pending_chat_message":
      return null;
    case "check_for_update":
      return null;
    case "install_update":
      return null;
    case "get_recent_projects":
      return [{ path: "C:/mock-project", last_opened: new Date().toISOString() }];
    case "open_project_folder":
      return MOCK_PROJECT;
    case "get_sketch":
      return MOCK_SKETCH;
    case "set_sidebar_order":
    case "update_sketch":
    case "update_sketch_title":
      return null;
    default:
      // Handle tauri-plugin-store commands
      if (cmd.startsWith("plugin:store|")) {
        return mockPluginStore(cmd, args);
      }
      // Handle tauri-plugin-event commands
      if (cmd.startsWith("plugin:event|")) {
        return mockPluginEvent(cmd, args);
      }
      // Handle plugin:window commands (minimize, maximize, etc.)
      if (cmd.startsWith("plugin:window|") || cmd.startsWith("plugin:updater|")) {
        return null;
      }
      console.warn(`[devMock] Unhandled invoke: ${cmd}`, args);
      return null;
  }
}

let nextRid = 1;

/** Mock plugin:store handler */
function mockPluginStore(cmd: string, args?: Record<string, unknown>): unknown {
  const op = cmd.replace("plugin:store|", "");
  switch (op) {
    case "load":
      return nextRid++;
    case "get_store":
      return nextRid++;
    case "get": {
      const key = args?.key as string;
      if (key && key in mockSettingsStore) {
        return [mockSettingsStore[key], true];
      }
      return [null, false];
    }
    case "set": {
      const key = args?.key as string;
      const value = args?.value as string;
      if (key) mockSettingsStore[key] = value;
      return null;
    }
    case "has": {
      const key = args?.key as string;
      return key ? key in mockSettingsStore : false;
    }
    case "keys":
      return Object.keys(mockSettingsStore);
    case "values":
      return Object.values(mockSettingsStore);
    case "save":
    case "clear":
    case "reset":
    case "delete":
      return null;
    default:
      console.warn(`[devMock] Unhandled store op: ${op}`);
      return null;
  }
}

/** Mock plugin:event handler */
function mockPluginEvent(cmd: string, _args?: Record<string, unknown>): unknown {
  const op = cmd.replace("plugin:event|", "");
  switch (op) {
    case "listen":
      return 0; // return a listener id
    case "unlisten":
      return null;
    default:
      return null;
  }
}

/**
 * Install mocks on the window so Tauri API modules pick them up.
 * Must be called BEFORE any Tauri imports are evaluated.
 */
export function installDevMocks() {
  if (typeof window === "undefined") return;

  // Mock __TAURI_INTERNALS__ for @tauri-apps/api/core invoke()
  const tauriInternals = (window as any).__TAURI_INTERNALS__;
  if (!tauriInternals) {
    const listeners = new Map<number, Function>();
    let listenerId = 0;

    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        // Small delay to simulate IPC
        await new Promise(r => setTimeout(r, cmd === "agent_chat_with_tools" ? 800 : 50));
        return mockInvoke(cmd, args);
      },
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      convertFileSrc: (path: string) => path,
      transformCallback: (fn: Function, once = false) => {
        const id = listenerId++;
        listeners.set(id, (...args: unknown[]) => {
          if (once) listeners.delete(id);
          fn(...args);
        });
        return id;
      },
      // Event system mock
      registerListener: (cb: Function) => {
        const id = listenerId++;
        listeners.set(id, cb);
        return id;
      },
      unregisterListener: (id: number) => {
        listeners.delete(id);
      },
    };

    // Mock event plugin internals (needed by @tauri-apps/plugin-event)
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      registerListener: (_event: string, _id: number, _handler: Function) => {},
      unregisterListener: (_event: string, _id: number) => {},
    };
    console.log("[devMock] Installed Tauri IPC mocks — app running in browser preview mode");
  }
}

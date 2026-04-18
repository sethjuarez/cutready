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
  repo_root: "C:/mock-project",
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
  { path: "storyboards/full-demo.sb", title: "Full Demo Flow", sketch_count: 2, created_at: "2025-01-15T09:00:00Z", updated_at: "2025-01-15T12:30:00Z" },
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

/**
 * Mock overrides — set from E2E tests via `window.__MOCK_OVERRIDES__`.
 * Keys are command names, values are the return values.
 */
const _overrides: Record<string, unknown> = {};

// Expose for E2E tests to set overrides
if (typeof window !== "undefined") {
  (window as any).__MOCK_OVERRIDES__ = _overrides;
}

/** Mock handler for Tauri invoke calls */
function mockInvoke(cmd: string, args?: Record<string, unknown>): unknown {
  // Check for E2E overrides first
  const overrides = (typeof window !== "undefined" && (window as any).__MOCK_OVERRIDES__) || _overrides;
  if (cmd in overrides) return overrides[cmd];

  switch (cmd) {
    case "open_project":
    case "get_project":
      return MOCK_PROJECT;
    case "list_recent_projects":
      return [{ path: "C:/mock-project", last_opened: new Date().toISOString() }];
    case "list_sketches":
      return MOCK_SKETCHES;
    case "list_all_files":
      return [
        { path: ".cutready", ext: "", size: 0, is_dir: true },
        { path: ".cutready/visuals", ext: "", size: 0, is_dir: true },
        { path: ".cutready/visuals/abc123def456.json", ext: "json", size: 2100, is_dir: false },
        { path: ".git", ext: "", size: 0, is_dir: true },
        { path: "sketches", ext: "", size: 0, is_dir: true },
        { path: "sketches/demo-introduction.sk", ext: "sk", size: 4200, is_dir: false },
        { path: "sketches/feature-deep-dive.sk", ext: "sk", size: 3800, is_dir: false },
        { path: "storyboards", ext: "", size: 0, is_dir: true },
        { path: "storyboards/full-demo.sb", ext: "sb", size: 950, is_dir: false },
        { path: "notes", ext: "", size: 0, is_dir: true },
        { path: "notes/research.md", ext: "md", size: 12400, is_dir: false },
        { path: "notes/meeting-notes.md", ext: "md", size: 8700, is_dir: false },
        { path: "project.json", ext: "json", size: 350, is_dir: false },
      ];
    case "read_sketch":
      return MOCK_SKETCH;
    case "save_sketch":
      return null;
    case "create_sketch":
      return "sketches/new-sketch.sk";
    case "delete_sketch":
    case "rename_sketch":
      return null;
    case "list_notes":
      return MOCK_NOTES;
    case "get_note":
    case "read_note":
      return MOCK_NOTE_CONTENT;
    case "save_note":
      return null;
    case "create_note":
      return "notes/new-note.md";
    case "delete_note":
    case "rename_note":
      return null;
    case "list_storyboards":
      return MOCK_STORYBOARDS;
    case "get_storyboard":
    case "read_storyboard":
      return {
        title: "Full Demo Flow",
        description: "End-to-end walkthrough of the platform's key features",
        items: [
          { type: "sketch_ref", path: "sketches/demo-introduction.sk" },
          { type: "sketch_ref", path: "sketches/feature-deep-dive.sk" },
        ],
        created_at: "2025-01-15T09:00:00Z",
        updated_at: "2025-01-15T12:30:00Z",
      };
    case "create_storyboard":
      return "storyboards/new.sb";
    case "delete_storyboard":
    case "rename_storyboard":
      return null;
    case "list_versions":
      return [
        { id: "abc123", message: "Initial draft", timestamp: "2025-01-15T10:00:00Z", summary: "Created demo introduction" },
        { id: "def456", message: "Added feature section", timestamp: "2025-01-15T11:00:00Z", summary: "Added deep dive section" },
      ];
    case "list_timelines":
      return [{ name: "main", label: "main", is_active: true, snapshot_count: 2, color_index: 0 }];
    case "get_graph":
    case "get_timeline_graph":
      return [
        { id: "def456", message: "Added feature section", timestamp: "2025-01-15T11:00:00Z", timeline: "main", parents: ["abc123"], lane: 0, is_head: true, is_branch_tip: true, is_remote_tip: false, author: "You" },
        { id: "abc123", message: "Initial draft", timestamp: "2025-01-15T10:00:00Z", timeline: "main", parents: [], lane: 0, is_head: false, is_branch_tip: false, is_remote_tip: false, author: "You" },
      ];
    case "has_unsaved_changes":
      return false;
    case "is_rewound":
      return false;
    case "check_git_identity":
      return { name: "Dev User", email: "dev@example.com", is_fallback: false };
    case "set_git_identity":
      return null;
    case "resolve_deep_link":
      return null;
    case "create_snapshot":
      return "new-snapshot-id";
    case "get_sidebar_order":
      return { storyboards: [], sketches: [], notes: [] };
    case "get_workspace_state":
      return { open_tabs: [], active_tab_id: null, chat_session_path: null };
    case "list_chat_sessions":
      return [];
    case "save_chat_session":
      return null;
    case "get_chat_session":
      return { title: "New Chat", messages: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    case "delete_chat_session":
      return null;
    case "get_memory_context":
      return "";
    case "archive_chat_session":
      return null;
    case "update_chat_summary":
      return null;
    case "list_memories":
      return [];
    case "delete_memory":
      return null;
    case "update_memory":
      return null;
    case "clear_memories":
      return 0;
    case "delete_feedback":
      return null;
    case "list_models":
      return [
        { id: "gpt-4o", owned_by: "openai", capabilities: { vision: "true" }, context_length: 128000 },
        { id: "gpt-4o-mini", owned_by: "openai", capabilities: {}, context_length: 128000 },
        { id: "gpt-4-turbo", owned_by: "openai", capabilities: { vision: "true" }, context_length: 128000 },
        { id: "o1-preview", owned_by: "openai", capabilities: {}, context_length: 128000 },
      ];
    case "list_azure_subscriptions":
      return [
        { subscription_id: "00000000-0000-0000-0000-000000000001", display_name: "Dev Subscription", state: "Enabled" },
        { subscription_id: "00000000-0000-0000-0000-000000000002", display_name: "Production", state: "Enabled" },
      ];
    case "list_azure_ai_resources":
      return [
        { name: "my-ai-services", resource_group: "rg-ai", kind: "AIServices", endpoint: "https://my-ai-services.services.ai.azure.com", location: "eastus2" },
        { name: "my-openai", resource_group: "rg-ai", kind: "OpenAI", endpoint: "https://my-openai.openai.azure.com", location: "westus" },
      ];
    case "list_foundry_projects":
      return [
        { name: "demo-project", endpoint: "https://my-ai-services.services.ai.azure.com/api/projects/demo-project" },
      ];
    case "azure_token_refresh":
      return { access_token: "mock-access-token", token_type: "Bearer", expires_in: 3600, refresh_token: "mock-refresh-token" };
    case "azure_browser_auth_start":
      return { auth_url: "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?mock=true", port: 54321 };
    case "azure_browser_auth_complete":
      return { access_token: "mock-oauth-token", token_type: "Bearer", expires_in: 3600, refresh_token: "mock-refresh-token" };
    case "agent_chat_with_tools": {
      // Simulate streaming with agent events
      const userMsgs = (args?.messages as Array<{ role: string; content: string }>) || [];
      const lastUser = userMsgs.filter(m => m.role === "user").pop();
      const response = `This is a mock response to: "${lastUser?.content?.substring(0, 50) || "your message"}"\n\nIn production, this would come from your configured AI provider. The chat UI is fully functional — try the @reference autocomplete, context picker, and model selector!`;
      const w = window as any;

      // Emit streaming events asynchronously
      const streamEvents = async () => {
        w.__TAURI_INTERNALS__?.emit?.("agent-event", { type: "status", message: "Thinking…" });
        await new Promise(r => setTimeout(r, 300));
        w.__TAURI_INTERNALS__?.emit?.("agent-event", { type: "tool_call", name: "list_project_files", arguments: "{}" });
        await new Promise(r => setTimeout(r, 200));
        w.__TAURI_INTERNALS__?.emit?.("agent-event", { type: "tool_result", name: "list_project_files", result: "sketches/intro.sk, notes/outline.md" });
        await new Promise(r => setTimeout(r, 200));
        w.__TAURI_INTERNALS__?.emit?.("agent-event", { type: "status", message: "Thinking… (round 2)" });
        await new Promise(r => setTimeout(r, 200));
        const words = response.split(" ");
        for (let i = 0; i < words.length; i++) {
          w.__TAURI_INTERNALS__?.emit?.("agent-event", { type: "delta", content: (i === 0 ? "" : " ") + words[i] });
          await new Promise(r => setTimeout(r, 30));
        }
        w.__TAURI_INTERNALS__?.emit?.("agent-event", { type: "done", response });
      };
      streamEvents(); // fire and forget

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
      // Delay the return so streaming events fire first
      return new Promise(resolve => setTimeout(() => resolve({
        messages: [...userMsgs, mockToolCall, mockToolResult],
        response,
      }), 2000));
    }
    case "push_pending_chat_message":
      return null;
    case "fetch_url_content":
      return `Mock web content for: ${args?.url ?? "unknown"}\n\nAzure Functions is a serverless compute service that lets you run event-triggered code without having to explicitly provision or manage infrastructure. You can write just the code you need for the problem at hand, without worrying about a whole application or the infrastructure to run it.\n\nKey Features:\n- Simplified programming model\n- Flexible hosting options\n- Built-in triggers and bindings\n- Pay-per-execution pricing\n- Integrated security\n\nAzure Functions supports triggers from HTTP requests, timers, Azure Storage, Azure Service Bus, and many more event sources. You can write functions in C#, JavaScript, Python, Java, and PowerShell.\n\nGetting Started:\n1. Create a function app in the Azure portal\n2. Choose your development environment\n3. Create your first function\n4. Test locally and deploy to Azure`;
    case "check_for_update":
      return null;
    case "install_update":
      return null;
    case "get_recent_projects":
      return [{ path: "C:/mock-project", last_opened: new Date().toISOString() }];
    case "open_project_folder":
      return MOCK_PROJECT;
    case "list_projects":
      return [{ path: ".", name: "Demo Project", description: null }];
    case "is_multi_project":
      return false;
    case "switch_project":
      return MOCK_PROJECT;
    case "create_project_in_repo":
      return { path: (args as { name: string }).name.toLowerCase().replace(/\s+/g, "-"), name: (args as { name: string }).name, description: null };
    case "delete_project":
      return null;
    case "rename_project":
      return (args as { newName: string }).newName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    case "migrate_to_multi_project":
      return { path: (args as { existingName: string }).existingName.toLowerCase().replace(/\s+/g, "-"), name: (args as { existingName: string }).existingName, description: null };
    case "transfer_asset":
      return null; // no-op in dev mock
    case "get_workspace_settings":
      return {};
    case "set_workspace_settings":
      return null;
    case "get_sketch":
      return MOCK_SKETCH;
    case "set_sidebar_order":
    case "set_workspace_state":
    case "promote_timeline":
    case "update_sketch":
    case "update_sketch_title":
      return null;
    case "list_feedback":
      return [
        { category: "bug", feedback: "The sketch editor sometimes loses focus when switching tabs quickly.", date: "2025-01-15T14:00:00Z" },
        { category: "feature", feedback: "Would love to see a timer overlay during recording.", date: "2025-01-15T10:30:00Z" },
        { category: "general", feedback: "Great app! The AI suggestions are really helpful for structuring demos.", date: "2025-01-14T16:00:00Z" },
      ];
    case "save_feedback":
    case "clear_feedback":
    case "export_logs":
      return null;
    case "create_github_issue":
      return "https://github.com/sethjuarez/cutready/issues/999";
    case "list_monitors":
      return [{ id: 0, name: "Primary Monitor", width: 1920, height: 1080, x: 0, y: 0, is_primary: true }];
    case "capture_screenshot":
      return null;
    case "list_project_images":
      return [
        { path: ".cutready/screenshots/screenshot-001.png", size: 245000, referencedBy: ["sketches/demo-introduction.sk"], assetType: "screenshot" },
        { path: ".cutready/screenshots/screenshot-002.png", size: 180000, referencedBy: ["sketches/demo-introduction.sk", "notes/script-draft.md"], assetType: "screenshot" },
        { path: ".cutready/screenshots/pasted-1705312000.png", size: 95000, referencedBy: [], assetType: "screenshot" },
        { path: ".cutready/visuals/a1b2c3d4e5f6.json", size: 3200, referencedBy: ["sketches/demo-introduction.sk"], assetType: "visual" },
        { path: ".cutready/visuals/deadbeef1234.json", size: 4100, referencedBy: [], assetType: "visual" },
      ];
    case "delete_project_image":
    case "delete_orphaned_images":
      return null;
    case "get_visual":
      // Return a sample elucim DSL document for visual thumbnails
      return {
        version: 1,
        root: {
          width: 960, height: 540, fps: 30, durationInFrames: 60,
          background: "$background",
          children: [
            { type: "rect", x: 80, y: 80, width: 800, height: 380, fill: "$surface", rx: 24 },
            { type: "text", x: 480, y: 240, content: "Sample Visual", fontSize: 48, fill: "$foreground", textAnchor: "middle" },
            { type: "text", x: 480, y: 310, content: "CutReady", fontSize: 28, fill: "$accent", textAnchor: "middle" },
          ],
        },
      };
    // Remote/versioning commands
    case "add_git_remote":
    case "remove_git_remote":
      return null;
    case "list_git_remotes":
      return [];
    case "detect_git_remote":
      return null;
    case "fetch_git_remote":
    case "push_git_remote":
      return null;
    case "get_sync_status":
      return { ahead: 0, behind: 0 };
    case "get_github_token":
      return null;
    case "pull_git_remote":
      return { type: "UpToDate" };
    case "list_remote_branches":
      return [];
    case "checkout_remote_branch":
      return null;
    case "diff_snapshots":
      return [
        { path: "sketches/demo-introduction.sk", status: "modified", additions: 5, deletions: 2 },
        { path: "notes/script.md", status: "added", additions: 12, deletions: 0 },
      ];
    case "check_large_files":
      return [];
    case "clone_from_url":
      return null;
    case "merge_timelines":
      return { status: "clean", commit_id: "merge-abc123" };
    case "apply_merge_resolution":
      return "resolved-merge-abc123";
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
function mockPluginEvent(cmd: string, args?: Record<string, unknown>): unknown {
  const op = cmd.replace("plugin:event|", "");
  const internals = (window as any).__TAURI_INTERNALS__;
  switch (op) {
    case "listen": {
      // Register event listener: args has { event, handler (callback id) }
      const event = args?.event as string;
      const handlerId = args?.handler as number;
      if (event && handlerId !== undefined && internals?._eventListeners) {
        if (!internals._eventListeners.has(event)) {
          internals._eventListeners.set(event, new Map());
        }
        const listener = internals._listeners?.get(handlerId);
        if (listener) {
          internals._eventListeners.get(event)!.set(handlerId, listener);
        }
      }
      return handlerId ?? 0;
    }
    case "unlisten": {
      const handlerId = args?.handler as number;
      const event = args?.event as string;
      if (event && internals?._eventListeners?.has(event)) {
        internals._eventListeners.get(event)!.delete(handlerId);
      }
      return null;
    }
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
    const eventListeners = new Map<string, Map<number, Function>>();
    let listenerId = 0;

    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        // Small delay to simulate IPC (but not for agent_chat since streaming handles timing)
        if (cmd !== "agent_chat_with_tools") {
          await new Promise(r => setTimeout(r, 50));
        }
        return mockInvoke(cmd, args);
      },
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      convertFileSrc: (path: string) => path,
      _listeners: listeners,
      _eventListeners: eventListeners,
      transformCallback: (fn: Function, once = false) => {
        const id = listenerId++;
        listeners.set(id, (...args: unknown[]) => {
          if (once) listeners.delete(id);
          fn(...args);
        });
        return id;
      },
      // Emit events to registered listeners
      emit: (event: string, payload: unknown) => {
        const handlers = eventListeners.get(event);
        if (handlers) {
          for (const handler of handlers.values()) {
            handler({ event, payload });
          }
        }
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

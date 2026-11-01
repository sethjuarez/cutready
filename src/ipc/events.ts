// Typed Tauri events (architecture v3: hand-written, desktop-only). Every
// event the frontend listens to or emits is named here with its payload, so
// listeners and emitters can't drift apart. Components use these helpers
// instead of raw `listen`/`emit` from services/tauri.
import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";
import { emit, listen } from "../services/tauri";
import type { RecordingTake } from "../types/recording";

/** Streamed agent run progress (`agent-event`). */
export interface AgentEvent {
  type: string;
  content?: string;
  message?: string;
  name?: string;
  arguments?: string;
  result?: string;
  status?: "success" | "failure";
  response?: string;
  agent_id?: string;
  task?: string;
  selected_count?: number;
  dropped_count?: number;
  total_bytes?: number;
  budget_bytes?: number;
  iteration?: number;
  attempt?: number;
  client_run_id?: string;
}

export interface WorkspaceSnapshotDeferredEvent {
  message?: unknown;
  reason?: unknown;
}

export interface TerminalExitedEvent {
  session_id: string;
}

export interface CaptureCompleteEvent {
  path: string;
}

export interface RecordingCountdownCancelEvent {
  attemptId?: number;
}

type Empty = Record<string, never>;

/** Payload by event name. `void` events carry no payload the frontend reads. */
export interface AppEvents {
  "agent-event": AgentEvent;
  "draftline://workspace_event": unknown;
  "workspace-snapshot-deferred": WorkspaceSnapshotDeferredEvent;
  "deep-link-received": string;
  "terminal-exited": TerminalExitedEvent;
  "toggle-recording": void;
  "capture-complete": CaptureCompleteEvent;
  "capture-cancel": Empty;
  "presentation-hotkey-next": void;
  "presentation-hotkey-previous": void;
  "presentation-hotkey-play-pause": void;
  "presentation-hotkey-speed-up": void;
  "presentation-hotkey-slow-down": void;
  "presentation-hotkey-toggle-mode": void;
  "presentation-hotkey-exit": void;
  "recording-control-started": RecordingTake;
  "recording-control-stopped": RecordingTake;
  "recording-control-discarded": RecordingTake;
  "recording-countdown-cancel": RecordingCountdownCancelEvent | null;
  "recording-prompter-next": void;
  "recording-prompter-previous": void;
  "recording-prompter-toggle-visibility": void;
  "recording-prompter-toggle-mode": void;
  "recording-prompter-read": Empty;
  "recording-prompter-adjust": void;
  "recording-prompter-close": Empty;
}

export type AppEventName = keyof AppEvents;

export function listenEvent<K extends AppEventName>(
  event: K,
  handler: EventCallback<AppEvents[K]>,
): Promise<UnlistenFn> {
  return listen<AppEvents[K]>(event, handler);
}

export function emitEvent<K extends AppEventName>(event: K, payload: AppEvents[K]): Promise<void> {
  return emit<AppEvents[K]>(event, payload);
}

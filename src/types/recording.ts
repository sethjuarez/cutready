/** TypeScript types for interaction recording sessions (Phase 1). */

import type { Action, SelectorStrategy } from "./project";

/** Metadata attached to every captured action. */
export interface ActionMetadata {
  captured_screenshot: string | null;
  selector_strategies: SelectorStrategy[];
  timestamp_ms: number;
  confidence: number;
  context_snapshot: string | null;
}

/** Where a raw event originated. */
export type EventSource =
  | "cdp"
  | "dom_observer"
  | "win_event_hook"
  | "input_hook";

/** Low-level event data from the capture source. */
export interface RawEvent {
  source: EventSource;
  data: string;
}

/** A single captured interaction with full context. */
export interface CapturedAction {
  action: Action;
  metadata: ActionMetadata;
  raw_event: RawEvent | null;
}

/** The recording mode for a session. */
export type RecordingMode = "free_form" | "step_by_step";

/** Raw output from the interaction recorder. */
export interface RecordedSession {
  id: string;
  mode: RecordingMode;
  sketch_id: string | null;
  started_at: string;
  ended_at: string | null;
  actions: CapturedAction[];
}

/** A browser profile detected on the system. */
export interface BrowserProfile {
  /** Browser identifier ("msedge" or "chrome"). */
  browser: string;
  /** Friendly browser name ("Edge" or "Chrome"). */
  browser_name: string;
  /** Profile directory name ("Default", "Profile 1", etc.). */
  profile_directory: string;
  /** User's display name for this profile. */
  display_name: string;
  /** Full path to the browser's User Data directory. */
  user_data_dir: string;
}

/** Which browser processes are currently running. */
export interface BrowserRunningStatus {
  msedge: boolean;
  chrome: boolean;
}

export type RecordingScope =
  | { kind: "sketch"; path: string }
  | { kind: "storyboard"; path: string };

export type CaptureSource = "full_screen" | "region" | "window";

export type OutputQuality = "lossless" | "high" | "compact";

export interface RecorderSettings {
  capture_source: CaptureSource;
  mic_device_id: string | null;
  countdown_seconds: number;
  include_cursor: boolean;
  output_quality: OutputQuality;
}

export type RecordingAssetKind = "screen" | "mic" | "camera" | "system_audio";
export type RecordingAssetStatus = "planned" | "local_only" | "missing" | "exported" | "uploaded";

export interface RecordingAssetRef {
  kind: RecordingAssetKind;
  /** Path relative to the take directory. */
  path: string;
  status: RecordingAssetStatus;
}

export interface RecordingMarker {
  /** Recording-relative timestamp. */
  time_ms: number;
  label: string;
}

export type RecordingTakeStatus = "prepared" | "recording" | "finalized" | "failed";

export interface RecordingTake {
  schema_version: number;
  id: string;
  scope: RecordingScope;
  settings: RecorderSettings;
  status: RecordingTakeStatus;
  created_at: string;
  updated_at: string;
  /** Path to take.json relative to the project root. */
  metadata_path: string;
  assets: RecordingAssetRef[];
  markers: RecordingMarker[];
}

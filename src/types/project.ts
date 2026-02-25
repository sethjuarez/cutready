/** TypeScript types mirroring the Rust data models for IPC. */

import type { Document } from "./document";

export interface ProjectSummary {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  name: string;
  settings: ProjectSettings;
  script: Script;
  documents: Document[];
  recordings: Recording[];
  animations: Animation[];
  created_at: string;
  updated_at: string;
}

export interface ProjectSettings {
  output_directory: string | null;
  recording_quality: RecordingQuality;
  frame_rate: number;
}

export type RecordingQuality = "low" | "medium" | "high" | "lossless";

export interface Script {
  rows: ScriptRow[];
}

export interface ScriptRow {
  id: string;
  time_ms: number;
  narrative: string;
  actions: Action[];
  screenshot: string | null;
  metadata: RowMetadata;
}

export interface RowMetadata {
  source: RowSource;
  refined: boolean;
}

export type RowSource = "recorded" | "manual" | "agent";

export interface Recording {
  id: string;
  video_path: string;
  narration_path: string | null;
  system_audio_path: string | null;
  duration_ms: number;
  tracks: TrackInfo[];
}

export interface TrackInfo {
  index: number;
  track_type: TrackType;
  title: string;
  codec: string;
}

export type TrackType = "video" | "audio";

export interface Animation {
  id: string;
  name: string;
  description: string;
  source_code: string;
  rendered_path: string | null;
  duration_ms: number | null;
}

// Action is a tagged union — this covers the main variants for display purposes.
// Full action type details will be expanded as features are implemented.
export type Action =
  | { type: "BrowserNavigate"; url: string }
  | { type: "BrowserClick"; selectors: SelectorStrategy[] }
  | { type: "BrowserType"; selectors: SelectorStrategy[]; text: string; clear_first: boolean }
  | { type: "BrowserSelect"; selectors: SelectorStrategy[]; value: string }
  | { type: "BrowserScroll"; direction: string; amount: number }
  | { type: "BrowserWaitForElement"; selectors: SelectorStrategy[]; timeout_ms: number }
  | { type: "NativeLaunch"; executable: string; args: string[] }
  | { type: "NativeClick"; selectors: SelectorStrategy[] }
  | { type: "NativeType"; text: string }
  | { type: "NativeSelect"; selectors: SelectorStrategy[]; value: string }
  | { type: "NativeInvoke"; selectors: SelectorStrategy[] }
  | { type: "Wait"; duration_ms: number }
  | { type: "Screenshot"; region: ScreenRegion | null; output_path: string }
  | { type: "Annotation"; text: string };

export interface SelectorStrategy {
  strategy: string;
  value: string;
}

export interface ScreenRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

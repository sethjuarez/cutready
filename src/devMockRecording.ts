// Web-shim fixtures for the recording commands. Typed against
// `RecordingCommands`, so a fixture that drifts from the real command shape
// fails `tsc` instead of misleading browser-only development.
import type { RecordingCommandName, RecordingCommands } from "./ipc/recording";
import type { PrompterScript, RecorderSettings, RecordingTake, RecordingTakeStatus } from "./types/recording";

type RecordingMocks = {
  [K in RecordingCommandName]: (args: RecordingCommands[K]["args"]) => RecordingCommands[K]["result"];
};

const DEV_SCRIPT: PrompterScript = {
  title: "Dev Mock Recording",
  steps: [
    {
      title: "Intro",
      section: null,
      narrative: "Show how the recorder follows a sketch while you click through the demo.",
      cue: "Open the app and point out the recorder controls.",
      source_path: "dev.sk",
      row_index: 0,
    },
    {
      title: "Intro",
      section: null,
      narrative: "Move to the next step with a hotkey or Stream Deck button.",
      cue: "Press Ctrl+Alt+Right.",
      source_path: "dev.sk",
      row_index: 1,
    },
  ],
};

const DEV_SETTINGS: RecorderSettings = {
  capture_source: "full_screen",
  capture_area: null,
  mic_device_id: null,
  camera_device_id: null,
  countdown_seconds: 3,
  frame_rate: 30,
  include_cursor: true,
  include_system_audio: false,
  mic_volume: 100,
  system_audio_volume: 100,
  output_quality: "high",
};

const DEV_FFMPEG = {
  available: true,
  ffmpeg_available: true,
  version: "ffmpeg version dev-mock",
  path: "ffmpeg",
  error: null,
  ffprobe_available: true,
  ffprobe_version: "ffprobe version dev-mock",
  ffprobe_path: "ffprobe",
  ffprobe_error: null,
};

function devTake(status: RecordingTakeStatus, overrides: Partial<RecordingTake> = {}): RecordingTake {
  return {
    schema_version: 1,
    id: "take_dev_mock",
    scope: { kind: "sketch", path: "dev.sk" },
    settings: DEV_SETTINGS,
    status,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    metadata_path: ".cutready/recordings/take_dev_mock/take.json",
    assets: [],
    markers: [],
    ...overrides,
  };
}

const isMacPlatform = () => navigator.platform.toLowerCase().includes("mac");

export const recordingMocks: RecordingMocks = {
  open_recording_countdown_window: () => undefined,
  close_recording_countdown_window: () => undefined,
  get_recording_countdown_params: () => ({
    monitor_id: 0,
    monitor_w: 1920,
    monitor_h: 1080,
    monitor_x: 0,
    monitor_y: 0,
    countdown_seconds: 3,
    document_title: "Dev Mock Recording",
    attempt_id: 0,
  }),
  get_recording_prompter_script: () => DEV_SCRIPT,
  get_recording_prompter_params: () => ({
    document_title: "Dev Mock Recording",
    read_mode: false,
    script: DEV_SCRIPT,
    monitor_x: 0,
    monitor_y: 0,
    monitor_w: 0,
    monitor_h: 0,
  }),
  open_recording_prompter_window: () => undefined,
  close_recording_prompter_window: () => undefined,
  open_recorder_window: () => undefined,
  close_recording_control_window: () => undefined,
  save_recording_control_position: () => undefined,
  get_recording_control_params: () => ({
    take_id: null,
    document_title: "Dev Mock Recording",
    scope: { kind: "sketch", path: "dev.sk" },
  }),
  discover_recording_devices: () => ({
    ffmpeg: DEV_FFMPEG,
    devices: [
      { id: "Studio Microphone", label: "Studio Microphone", kind: "microphone", is_default: false },
      { id: "default-output", label: "Studio Speakers", kind: "system_audio", is_default: true },
      {
        id: "Integrated Camera",
        label: "Integrated Camera",
        kind: "camera",
        is_default: false,
        camera_formats: [{ width: 3840, height: 2160, fps: "30", codec: "mjpeg", pixel_format: null }],
      },
    ],
  }),
  get_recording_platform_capabilities: () => ({
    platform: isMacPlatform() ? "macos" : "windows",
    supports_system_audio: !isMacPlatform(),
    supports_native_monitor_capture: true,
    supports_window_capture_exclusion: !isMacPlatform(),
    supports_click_through_prompter: true,
    supports_camera_format_discovery: true,
    system_audio_hint: isMacPlatform()
      ? "Requires a virtual audio driver (BlackHole is free). Install it, then create a Multi-Output Device in Audio MIDI Setup that combines your speakers + BlackHole."
      : null,
  }),
  discover_camera_formats: () => [{ width: 3840, height: 2160, fps: "30", codec: "mjpeg", pixel_format: null }],
  start_recording_take: (args) =>
    devTake("recording", {
      scope: args?.scope ?? { kind: "sketch", path: "dev.sk" },
      settings: args?.settings ?? DEV_SETTINGS,
      assets: [{ kind: "screen", path: "screen.mp4", status: "planned" }],
    }),
  get_recording_audio_level: () => ({
    available: true,
    rms: 0.035 + Math.random() * 0.045,
    peak: 0.08 + Math.random() * 0.18,
    bytes: 65536,
  }),
  stop_recording_take: () => devTake("finalized", { assets: [{ kind: "screen", path: "screen.mp4", status: "local_only" }] }),
  discard_recording_take: () => devTake("failed"),
  clear_local_recordings: () => 0,
};

export function isRecordingMockCommand(cmd: string): cmd is RecordingCommandName {
  return Object.prototype.hasOwnProperty.call(recordingMocks, cmd);
}

export function mockRecordingInvoke(cmd: RecordingCommandName, args: Record<string, unknown> | undefined): unknown {
  const handler = recordingMocks[cmd] as (args: unknown) => unknown;
  return handler(args);
}

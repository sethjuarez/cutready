// Typed recording commands (architecture v3 F4). Recording components call
// these wrappers instead of raw `invoke`; devMock implements the same
// `RecordingCommands` map, so fixtures can't drift from the real shapes.
import { invoke } from "../services/tauri";
import type {
  CameraFormatInfo,
  PrompterScript,
  RecorderSettings,
  RecordingAudioLevel,
  RecordingControlParams,
  RecordingCountdownParams,
  RecordingDeviceDiscovery,
  RecordingPlatformCapabilities,
  RecordingPrompterParams,
  RecordingScope,
  RecordingTake,
} from "../types/recording";

/** A monitor rectangle in physical pixels, as the window commands take it. */
export interface PhysicalRect {
  physX: number;
  physY: number;
  physW: number;
  physH: number;
}

export interface OpenRecorderArgs {
  scope: RecordingScope;
  documentTitle: string;
}

export interface OpenPrompterArgs extends PhysicalRect {
  scope: RecordingScope;
  documentTitle: string;
  readMode: boolean;
}

export interface OpenCountdownArgs extends PhysicalRect {
  monitorId: number;
  countdownSeconds: number;
  documentTitle: string;
  attemptId: number;
}

type Command<Args, Result> = { args: Args; result: Result };

/** Arguments and result by command name. `undefined` args means none. */
export interface RecordingCommands {
  discover_recording_devices: Command<undefined, RecordingDeviceDiscovery>;
  discover_camera_formats: Command<{ cameraDeviceId: string }, CameraFormatInfo[]>;
  get_recording_platform_capabilities: Command<undefined, RecordingPlatformCapabilities>;
  get_recording_audio_level: Command<undefined, RecordingAudioLevel>;
  get_recording_prompter_script: Command<{ scope: RecordingScope }, PrompterScript>;
  start_recording_take: Command<{ scope: RecordingScope; settings: RecorderSettings }, RecordingTake>;
  stop_recording_take: Command<undefined, RecordingTake>;
  discard_recording_take: Command<undefined, RecordingTake>;
  clear_local_recordings: Command<undefined, number>;
  open_recorder_window: Command<OpenRecorderArgs, void>;
  get_recording_control_params: Command<undefined, RecordingControlParams>;
  save_recording_control_position: Command<{ position: { x: number; y: number } }, void>;
  close_recording_control_window: Command<undefined, void>;
  open_recording_countdown_window: Command<OpenCountdownArgs, void>;
  get_recording_countdown_params: Command<undefined, RecordingCountdownParams>;
  close_recording_countdown_window: Command<undefined, void>;
  open_recording_prompter_window: Command<OpenPrompterArgs, void>;
  get_recording_prompter_params: Command<undefined, RecordingPrompterParams>;
  close_recording_prompter_window: Command<undefined, void>;
}

export type RecordingCommandName = keyof RecordingCommands;
type Args<K extends RecordingCommandName> = RecordingCommands[K]["args"];
type Result<K extends RecordingCommandName> = RecordingCommands[K]["result"];

function call<K extends RecordingCommandName>(
  command: K,
  ...args: Args<K> extends undefined ? [] : [Args<K>]
): Promise<Result<K>> {
  return args.length === 0
    ? invoke<Result<K>>(command)
    : invoke<Result<K>>(command, args[0] as Record<string, unknown>);
}

export const recordingIpc = {
  discoverDevices: () => call("discover_recording_devices"),
  discoverCameraFormats: (cameraDeviceId: string) => call("discover_camera_formats", { cameraDeviceId }),
  platformCapabilities: () => call("get_recording_platform_capabilities"),
  audioLevel: () => call("get_recording_audio_level"),
  prompterScript: (scope: RecordingScope) => call("get_recording_prompter_script", { scope }),
  startTake: (scope: RecordingScope, settings: RecorderSettings) => call("start_recording_take", { scope, settings }),
  stopTake: () => call("stop_recording_take"),
  discardTake: () => call("discard_recording_take"),
  clearLocalRecordings: () => call("clear_local_recordings"),
  openRecorderWindow: (args: OpenRecorderArgs) => call("open_recorder_window", args),
  controlParams: () => call("get_recording_control_params"),
  saveControlPosition: (x: number, y: number) => call("save_recording_control_position", { position: { x, y } }),
  closeControlWindow: () => call("close_recording_control_window"),
  openCountdownWindow: (args: OpenCountdownArgs) => call("open_recording_countdown_window", args),
  countdownParams: () => call("get_recording_countdown_params"),
  closeCountdownWindow: () => call("close_recording_countdown_window"),
  openPrompterWindow: (args: OpenPrompterArgs) => call("open_recording_prompter_window", args),
  prompterParams: () => call("get_recording_prompter_params"),
  closePrompterWindow: () => call("close_recording_prompter_window"),
};

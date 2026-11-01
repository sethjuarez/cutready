import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => undefined),
  emit: vi.fn(async () => undefined),
}));
vi.mock("../services/tauri", () => tauri);

import { emitEvent, listenEvent } from "../ipc/events";
import { recordingIpc } from "../ipc/recording";
import { isRecordingMockCommand, recordingMocks } from "../devMockRecording";
import type { RecorderSettings, RecordingScope } from "../types/recording";

const scope: RecordingScope = { kind: "sketch", path: "intro.sk" };

describe("typed IPC wrappers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("delegates events to the telemetry-wrapped listen/emit", async () => {
    const handler = vi.fn();
    await listenEvent("terminal-exited", handler);
    expect(tauri.listen).toHaveBeenCalledWith("terminal-exited", handler);
    await emitEvent("capture-complete", { path: "shot.png" });
    expect(tauri.emit).toHaveBeenCalledWith("capture-complete", { path: "shot.png" });
  });

  it("invokes no-arg recording commands without an args object", async () => {
    await recordingIpc.stopTake();
    await recordingIpc.closeCountdownWindow();
    expect(tauri.invoke.mock.calls).toEqual([["stop_recording_take"], ["close_recording_countdown_window"]]);
  });

  it("passes recording command args with the backend's names", async () => {
    const settings = { countdown_seconds: 3 } as RecorderSettings;
    const rect = { physX: 1, physY: 2, physW: 3, physH: 4 };
    await recordingIpc.startTake(scope, settings);
    await recordingIpc.discoverCameraFormats("cam");
    await recordingIpc.prompterScript(scope);
    await recordingIpc.saveControlPosition(10, 20);
    await recordingIpc.openRecorderWindow({ scope, documentTitle: "Intro" });
    await recordingIpc.openPrompterWindow({ scope, documentTitle: "Intro", readMode: true, ...rect });
    await recordingIpc.openCountdownWindow({ monitorId: 0, countdownSeconds: 3, documentTitle: "Intro", attemptId: 7, ...rect });
    expect(tauri.invoke.mock.calls).toEqual([
      ["start_recording_take", { scope, settings }],
      ["discover_camera_formats", { cameraDeviceId: "cam" }],
      ["get_recording_prompter_script", { scope }],
      ["save_recording_control_position", { position: { x: 10, y: 20 } }],
      ["open_recorder_window", { scope, documentTitle: "Intro" }],
      ["open_recording_prompter_window", { scope, documentTitle: "Intro", readMode: true, ...rect }],
      ["open_recording_countdown_window", { monitorId: 0, countdownSeconds: 3, documentTitle: "Intro", attemptId: 7, ...rect }],
    ]);
  });

  it("has a devMock fixture for every recording command", () => {
    expect(isRecordingMockCommand("stop_recording_take")).toBe(true);
    expect(isRecordingMockCommand("toString")).toBe(false);
    expect(recordingMocks.start_recording_take({ scope, settings: { countdown_seconds: 5 } as RecorderSettings })).toMatchObject({
      scope,
      settings: { countdown_seconds: 5 },
      status: "recording",
    });
  });
});

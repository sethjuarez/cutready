import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingControlWindow } from "../components/RecordingControlWindow";

const mocks = vi.hoisted(() => {
  const closeState: { handler: null | ((event: { preventDefault: () => void }) => void) } = { handler: null };
  return {
    emit: vi.fn((..._args: unknown[]) => Promise.resolve()),
    invoke: vi.fn(),
    setSize: vi.fn(() => Promise.resolve()),
    startDragging: vi.fn(() => Promise.resolve()),
    closeState,
    onCloseRequested: vi.fn((handler: (event: { preventDefault: () => void }) => void) => {
      closeState.handler = handler;
      return Promise.resolve(() => undefined);
    }),
    onMoved: vi.fn(() => Promise.resolve(() => undefined)),
    updateSetting: vi.fn(() => Promise.resolve()),
    refreshDevices: vi.fn(),
    settings: {
      recorderMicDeviceId: "",
      recorderMicVolume: 100,
      recorderMonitorPreference: "",
      recorderCameraEnabled: false,
      recorderCameraDeviceId: "",
      recorderSystemAudioEnabled: false,
      recorderSystemAudioVolume: 100,
      recorderFrameRate: 30,
      recorderCountdownSeconds: 0,
      recorderIncludeCursor: true,
      recorderOutputQuality: "high",
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: (...args: unknown[]) => mocks.emit(...args),
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

vi.mock("@tauri-apps/api/window", () => ({
  LogicalSize: class LogicalSize {
    constructor(
      public width: number,
      public height: number,
    ) {}
  },
  getCurrentWindow: () => ({
    setSize: mocks.setSize,
    startDragging: mocks.startDragging,
    onCloseRequested: mocks.onCloseRequested,
    onMoved: mocks.onMoved,
  }),
}));

vi.mock("../hooks/useSettings", () => ({
  useSettings: () => ({
    loaded: true,
    settings: mocks.settings,
    updateSetting: mocks.updateSetting,
  }),
}));

vi.mock("../hooks/useRecordingDevices", () => ({
  useRecordingDevices: () => ({
    microphones: [{ id: "mic-1", label: "Studio Mic", is_default: true }],
    cameras: [{
      id: "camera-1",
      label: "Studio Camera",
      is_default: false,
      camera_formats: [{ width: 3840, height: 2160, fps: "30", codec: "mjpeg", pixel_format: null }],
    }],
    systemAudioDevices: [{ id: "system", label: "System audio", is_default: true }],
    loading: false,
    error: null,
    refresh: mocks.refreshDevices,
  }),
}));

const scope = { kind: "sketch", path: "intro.sk" };
const monitors = [
  {
    id: 0,
    name: "Primary Display",
    device_name: "\\\\.\\DISPLAY1",
    hmonitor: "0x001",
    dxgi_output_index: 1,
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    is_primary: true,
  },
];
const secondaryMonitor = {
  id: 1,
  name: "Demo Display",
  device_name: "\\\\.\\DISPLAY2",
  hmonitor: "0x002",
  dxgi_output_index: 2,
  x: 1920,
  y: 0,
  width: 2560,
  height: 1440,
  is_primary: false,
};

describe("RecordingControlWindow", () => {
  beforeEach(() => {
    Object.assign(mocks.settings, {
      recorderMicDeviceId: "",
      recorderMicVolume: 100,
      recorderMonitorPreference: "",
      recorderCameraEnabled: false,
      recorderCameraDeviceId: "",
      recorderSystemAudioEnabled: false,
      recorderSystemAudioVolume: 100,
      recorderFrameRate: 30,
      recorderCountdownSeconds: 0,
      recorderIncludeCursor: true,
      recorderOutputQuality: "high",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    mocks.closeState.handler = null;
  });

  it("starts a take with the selected screen and separate audio settings", async () => {
    Object.defineProperty(window.navigator, "userAgent", { value: "Windows", configurable: true });
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_recording_control_params") return Promise.resolve({ document_title: "Intro sketch", scope });
      if (command === "list_monitors") return Promise.resolve(monitors);
      if (command === "get_recording_audio_level") return Promise.resolve({ available: false, rms: 0, peak: 0, bytes: 0 });
      if (command === "close_recording_countdown_window") return Promise.resolve();
      if (command === "start_recording_take") return Promise.resolve({ id: "take_1", status: "recording", scope });
      return Promise.resolve();
    });

    render(<RecordingControlWindow />);

    await screen.findByText("Intro sketch");
    const [, cameraSelect, microphoneSelect, frameRateSelect] = screen.getAllByRole("combobox");
    fireEvent.change(microphoneSelect, { target: { value: "mic-1" } });
    fireEvent.change(cameraSelect, { target: { value: "camera-1" } });
    fireEvent.change(frameRateSelect, { target: { value: "60" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /system audio/i }));
    await waitFor(() => expect(microphoneSelect).toHaveValue("mic-1"));
    await waitFor(() => expect(cameraSelect).toHaveValue("camera-1"));
    await waitFor(() => expect(frameRateSelect).toHaveValue("60"));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /system audio/i })).toBeChecked());
    fireEvent.change(screen.getByRole("slider", { name: /microphone volume/i }), { target: { value: "125" } });
    fireEvent.change(screen.getByRole("slider", { name: /system audio volume/i }), { target: { value: "80" } });
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("start_recording_take", expect.anything()));
    expect(mocks.invoke).toHaveBeenCalledWith("start_recording_take", {
      scope,
      settings: expect.objectContaining({
        capture_source: "full_screen",
        capture_backend: "auto",
        mic_device_id: "mic-1",
        camera_device_id: "camera-1",
        camera_format: expect.objectContaining({ width: 3840, height: 2160, fps: "30", codec: "mjpeg" }),
        include_system_audio: true,
        mic_volume: 125,
        system_audio_volume: 80,
        frame_rate: 60,
        include_cursor: true,
        output_quality: "high",
        capture_area: expect.objectContaining({
          display_index: 0,
          hmonitor: "0x001",
          dxgi_output_index: 1,
          width: 1920,
          height: 1080,
        }),
      }),
    });
    expect(mocks.emit).toHaveBeenCalledWith("recording-control-started", expect.objectContaining({ id: "take_1" }));
    expect(mocks.updateSetting).toHaveBeenCalledWith("recorderCameraDeviceId", "camera-1");
    expect(mocks.updateSetting).toHaveBeenCalledWith("recorderCameraEnabled", true);
    expect(mocks.updateSetting).toHaveBeenCalledWith("recorderMicVolume", 125);
    expect(mocks.updateSetting).toHaveBeenCalledWith("recorderSystemAudioVolume", 80);
    expect(mocks.updateSetting).toHaveBeenCalledWith("recorderMonitorPreference", "\\\\.\\DISPLAY1|1920|1080|primary");
  });

  it("restores the last selected monitor when opening setup", async () => {
    mocks.settings.recorderMonitorPreference = "\\\\.\\DISPLAY2|2560|1440|secondary";
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_recording_control_params") return Promise.resolve({ document_title: "Intro sketch", scope });
      if (command === "list_monitors") return Promise.resolve([...monitors, secondaryMonitor]);
      return Promise.resolve();
    });

    render(<RecordingControlWindow />);

    await screen.findByText("Intro sketch");
    await waitFor(() => expect(screen.getAllByRole("combobox")[0]).toHaveValue("1"));
  });

  it("captures a one-frame screen preview from the selected monitor", async () => {
    mocks.invoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "get_current_project") return Promise.resolve({ root: "D:\\demo", name: "Demo", repo_root: "D:\\demo" });
      if (command === "get_recording_control_params") return Promise.resolve({ document_title: "Intro sketch", scope });
      if (command === "list_monitors") return Promise.resolve(monitors);
      if (command === "capture_fullscreen") return Promise.resolve(".cutready/screenshots/preview.png");
      return Promise.resolve(args);
    });

    render(<RecordingControlWindow />);

    await screen.findByText("Intro sketch");
    fireEvent.click(screen.getByRole("button", { name: /preview screen/i }));

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("capture_fullscreen", { monitorId: 0 }));
    expect(await screen.findByRole("button", { name: /close preview/i })).toBeInTheDocument();
  });

  it("uses the header strip to drag the recorder window", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_recording_control_params") return Promise.resolve({ document_title: "Intro sketch", scope });
      if (command === "list_monitors") return Promise.resolve(monitors);
      return Promise.resolve();
    });

    render(<RecordingControlWindow />);

    fireEvent.mouseDown(await screen.findByLabelText("Drag recorder window"));

    expect(mocks.startDragging).toHaveBeenCalledTimes(1);
  });

  it("closes the setup recorder window from the header close button", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_recording_control_params") return Promise.resolve({ document_title: "Intro sketch", scope });
      if (command === "list_monitors") return Promise.resolve(monitors);
      if (command === "close_recording_control_window") return Promise.resolve();
      return Promise.resolve();
    });

    render(<RecordingControlWindow />);

    fireEvent.click(await screen.findByRole("button", { name: /^close recorder$/i }));

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("close_recording_control_window"));
  });

  it("opens as a compact stop control for an active take", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_recording_control_params") return Promise.resolve({ document_title: "Demo storyboard", take_id: "take_active" });
      if (command === "list_monitors") return Promise.resolve(monitors);
      if (command === "get_recording_audio_level") return Promise.resolve({ available: true, rms: 0.4, peak: 0.8, bytes: 2048 });
      if (command === "close_recording_countdown_window") return Promise.resolve();
      if (command === "stop_recording_take") return Promise.resolve({ id: "take_active", status: "finalized" });
      if (command === "close_recording_control_window") return Promise.resolve();
      return Promise.resolve();
    });

    render(<RecordingControlWindow />);

    await screen.findByRole("button", { name: /stop recording and save/i });
    fireEvent.click(screen.getByRole("button", { name: /stop recording and save/i }));

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("stop_recording_take"));
    expect(mocks.emit).toHaveBeenCalledWith("recording-control-stopped", expect.objectContaining({ id: "take_active" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("close_recording_control_window"));
  });

  it("cancels an active take and emits a discard event", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_recording_control_params") return Promise.resolve({ document_title: "Demo storyboard", take_id: "take_bad" });
      if (command === "list_monitors") return Promise.resolve(monitors);
      if (command === "get_recording_audio_level") return Promise.resolve({ available: true, rms: 0.4, peak: 0.8, bytes: 2048 });
      if (command === "close_recording_countdown_window") return Promise.resolve();
      if (command === "discard_recording_take") return Promise.resolve({ id: "take_bad", status: "failed", scope });
      if (command === "close_recording_control_window") return Promise.resolve();
      return Promise.resolve();
    });

    render(<RecordingControlWindow />);

    await screen.findByRole("button", { name: /cancel recording without saving/i });
    fireEvent.click(screen.getByRole("button", { name: /cancel recording without saving/i }));

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("discard_recording_take"));
    expect(mocks.emit).toHaveBeenCalledWith("recording-control-discarded", expect.objectContaining({ id: "take_bad" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("close_recording_control_window"));
  });

  it("closes an active recording window as cancel and discard", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const preventDefault = vi.fn();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_recording_control_params") return Promise.resolve({ document_title: "Demo storyboard", take_id: "take_close" });
      if (command === "list_monitors") return Promise.resolve(monitors);
      if (command === "get_recording_audio_level") return Promise.resolve({ available: true, rms: 0.4, peak: 0.8, bytes: 2048 });
      if (command === "close_recording_countdown_window") return Promise.resolve();
      if (command === "discard_recording_take") return Promise.resolve({ id: "take_close", status: "failed", scope });
      if (command === "close_recording_control_window") return Promise.resolve();
      return Promise.resolve();
    });

    render(<RecordingControlWindow />);

    await screen.findByRole("button", { name: /cancel recording without saving/i });
    act(() => {
      mocks.closeState.handler?.({ preventDefault });
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("discard_recording_take"));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(mocks.emit).toHaveBeenCalledWith("recording-control-discarded", expect.objectContaining({ id: "take_close" }));
  });
});

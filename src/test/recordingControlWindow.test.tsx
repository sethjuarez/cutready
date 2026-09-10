import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingControlWindow } from "../components/RecordingControlWindow";

const mocks = vi.hoisted(() => {
  const closeState: { handler: null | ((event: { preventDefault: () => void }) => void) } = { handler: null };
  const listeners: Record<string, (event: { payload?: unknown }) => void> = {};
  return {
    emit: vi.fn((..._args: unknown[]) => Promise.resolve()),
    invoke: vi.fn(),
    setSize: vi.fn(() => Promise.resolve()),
    startDragging: vi.fn(() => Promise.resolve()),
    closeState,
    listeners,
    listen: vi.fn((event: string, handler: (e: { payload?: unknown }) => void) => {
      listeners[event] = handler;
      return Promise.resolve(() => {
        delete listeners[event];
      });
    }),
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
  listen: (...args: unknown[]) => (mocks.listen as (...a: unknown[]) => unknown)(...args),
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
    for (const key of Object.keys(mocks.listeners)) delete mocks.listeners[key];
  });

  it("starts a take with the selected screen and separate audio settings", async () => {
    Object.defineProperty(window.navigator, "userAgent", { value: "Windows", configurable: true });
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_recording_control_params") return Promise.resolve({ document_title: "Intro sketch", scope });
      if (command === "get_recording_platform_capabilities") return Promise.resolve({
        platform: "windows",
        supports_system_audio: true,
        supports_native_monitor_capture: true,
        supports_window_capture_exclusion: true,
        supports_click_through_prompter: true,
        supports_camera_format_discovery: true,
      });
      if (command === "list_monitors") return Promise.resolve(monitors);
      if (command === "get_recording_audio_level") return Promise.resolve({ available: false, rms: 0, peak: 0, bytes: 0 });
      if (command === "close_recording_countdown_window") return Promise.resolve();
      if (command === "start_recording_take") return Promise.resolve({ id: "take_1", status: "recording", scope });
      return Promise.resolve();
    });

    render(<RecordingControlWindow />);

    await screen.findByText("Intro sketch");
    const [, cameraSelect, microphoneSelect, frameRateSelect] = screen.getAllByRole("combobox");
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /system audio/i })).toBeEnabled());
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

  it("disables system audio when platform capabilities do not support it", async () => {
    mocks.settings.recorderSystemAudioEnabled = true;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_recording_control_params") return Promise.resolve({ document_title: "Intro sketch", scope });
      if (command === "get_recording_platform_capabilities") return Promise.resolve({
        platform: "macos",
        supports_system_audio: false,
        supports_native_monitor_capture: false,
        supports_window_capture_exclusion: false,
        supports_click_through_prompter: true,
        supports_camera_format_discovery: false,
      });
      if (command === "list_monitors") return Promise.resolve(monitors);
      return Promise.resolve();
    });

    render(<RecordingControlWindow />);

    await screen.findByText("Intro sketch");
    await waitFor(() => expect(screen.getByText("Unavailable on this platform")).toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: /system audio/i })).toBeDisabled();
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

  it("opens prompter preview in adjust mode and recording prompter in read mode", async () => {
    const prompterScript = {
      title: "Intro sketch",
      steps: [{
        title: "Intro",
        section: null,
        narrative: "Read this line while recording.",
        cue: "Click the first button.",
        source_path: "intro.sk",
        row_index: 0,
      }],
    };
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_recording_control_params") return Promise.resolve({ document_title: "Intro sketch", scope });
      if (command === "get_recording_platform_capabilities") return Promise.resolve({
        platform: "windows",
        supports_system_audio: true,
        supports_native_monitor_capture: true,
        supports_window_capture_exclusion: true,
        supports_click_through_prompter: true,
        supports_camera_format_discovery: true,
      });
      if (command === "list_monitors") return Promise.resolve(monitors);
      if (command === "get_recording_prompter_script") return Promise.resolve(prompterScript);
      if (command === "open_recording_prompter_window") return Promise.resolve();
      if (command === "close_recording_countdown_window") return Promise.resolve();
      if (command === "get_recording_audio_level") return Promise.resolve({ available: false, rms: 0, peak: 0, bytes: 0 });
      if (command === "start_recording_take") return Promise.resolve({ id: "take_1", status: "recording", scope });
      return Promise.resolve();
    });

    render(<RecordingControlWindow />);

    await screen.findByText("Intro sketch");
    await waitFor(() => expect(screen.getByText("1 manual steps")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /preview prompter/i }));

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("open_recording_prompter_window", expect.objectContaining({
      readMode: false,
      physX: 0,
      physY: 0,
      physW: 1920,
      physH: 1080,
    })));

    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("open_recording_prompter_window", expect.objectContaining({
      readMode: true,
      physX: 0,
      physY: 0,
      physW: 1920,
      physH: 1080,
    })));
    expect(mocks.emit).toHaveBeenCalledWith("recording-prompter-read", {});
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
    fireEvent.click(await screen.findByRole("button", { name: /^discard$/i }));

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
    await waitFor(() => expect(mocks.onCloseRequested.mock.calls.length).toBeGreaterThanOrEqual(2));
    act(() => {
      mocks.closeState.handler?.({ preventDefault });
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("discard_recording_take"));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(mocks.emit).toHaveBeenCalledWith("recording-control-discarded", expect.objectContaining({ id: "take_close" }));
  });

  it("discards a start that completes after a close was requested during startup", async () => {
    let resolveStart: (take: unknown) => void = () => {};
    const preventDefault = vi.fn();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_recording_control_params") return Promise.resolve({ document_title: "Intro sketch", scope });
      if (command === "get_recording_platform_capabilities") return Promise.resolve({
        platform: "windows",
        supports_system_audio: true,
        supports_native_monitor_capture: true,
        supports_window_capture_exclusion: true,
        supports_click_through_prompter: true,
        supports_camera_format_discovery: true,
      });
      if (command === "list_monitors") return Promise.resolve(monitors);
      if (command === "get_recording_audio_level") return Promise.resolve({ available: false, rms: 0, peak: 0, bytes: 0 });
      if (command === "close_recording_countdown_window") return Promise.resolve();
      if (command === "start_recording_take") return new Promise((resolve) => { resolveStart = resolve; });
      if (command === "discard_recording_take") return Promise.resolve({ id: "take_late", status: "failed", scope });
      if (command === "close_recording_control_window") return Promise.resolve();
      return Promise.resolve();
    });

    render(<RecordingControlWindow />);

    await screen.findByText("Intro sketch");
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("start_recording_take", expect.anything()));

    // Request close while the native start is still in flight.
    await waitFor(() => expect(mocks.onCloseRequested.mock.calls.length).toBeGreaterThanOrEqual(1));
    act(() => {
      mocks.closeState.handler?.({ preventDefault });
    });
    // Cleanup is deferred to the pending start — the window is not closed yet.
    expect(mocks.invoke).not.toHaveBeenCalledWith("close_recording_control_window");

    // The start now completes: the just-installed capture must be discarded and
    // the window closed, and success must NOT be published to the main window.
    await act(async () => {
      resolveStart({ id: "take_late", status: "recording", scope });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("discard_recording_take"));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("close_recording_control_window"));
    expect(mocks.emit).not.toHaveBeenCalledWith("recording-control-started", expect.anything());
  });

  it("closes without starting native capture when canceled during the countdown", async () => {
    mocks.settings.recorderCountdownSeconds = 5;
    const preventDefault = vi.fn();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_recording_control_params") return Promise.resolve({ document_title: "Intro sketch", scope });
      if (command === "get_recording_platform_capabilities") return Promise.resolve({
        platform: "windows",
        supports_system_audio: true,
        supports_native_monitor_capture: true,
        supports_window_capture_exclusion: true,
        supports_click_through_prompter: true,
        supports_camera_format_discovery: true,
      });
      if (command === "list_monitors") return Promise.resolve(monitors);
      if (command === "get_recording_audio_level") return Promise.resolve({ available: false, rms: 0, peak: 0, bytes: 0 });
      if (command === "open_recording_countdown_window") return Promise.resolve();
      if (command === "close_recording_countdown_window") return Promise.resolve();
      if (command === "close_recording_control_window") return Promise.resolve();
      if (command === "start_recording_take") return Promise.resolve({ id: "should_not_start", status: "recording", scope });
      return Promise.resolve();
    });

    render(<RecordingControlWindow />);

    await screen.findByText("Intro sketch");
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("open_recording_countdown_window", expect.anything()));

    await waitFor(() => expect(mocks.onCloseRequested.mock.calls.length).toBeGreaterThanOrEqual(1));
    await act(async () => {
      mocks.closeState.handler?.({ preventDefault });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("close_recording_control_window"));
    expect(mocks.invoke).not.toHaveBeenCalledWith("start_recording_take", expect.anything());
  });

  it("ignores a concurrent second start while one is already in flight", async () => {
    let startCalls = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_recording_control_params") return Promise.resolve({ document_title: "Intro sketch", scope });
      if (command === "get_recording_platform_capabilities") return Promise.resolve({
        platform: "windows",
        supports_system_audio: true,
        supports_native_monitor_capture: true,
        supports_window_capture_exclusion: true,
        supports_click_through_prompter: true,
        supports_camera_format_discovery: true,
      });
      if (command === "list_monitors") return Promise.resolve(monitors);
      if (command === "get_recording_audio_level") return Promise.resolve({ available: false, rms: 0, peak: 0, bytes: 0 });
      if (command === "close_recording_countdown_window") return Promise.resolve();
      if (command === "start_recording_take") {
        startCalls += 1;
        return Promise.resolve({ id: "take_1", status: "recording", scope });
      }
      return Promise.resolve();
    });

    render(<RecordingControlWindow />);

    await screen.findByText("Intro sketch");
    const startButton = screen.getByRole("button", { name: /start recording/i });
    await act(async () => {
      fireEvent.click(startButton);
      fireEvent.click(startButton);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(startCalls).toBe(1));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(startCalls).toBe(1);
  });

  it("returns to setup and releases the guard on a countdown-cancel event", async () => {
    mocks.settings.recorderCountdownSeconds = 5;
    let countdownOpens = 0;
    let startCalls = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_recording_control_params") return Promise.resolve({ document_title: "Intro sketch", scope });
      if (command === "get_recording_platform_capabilities") return Promise.resolve({
        platform: "windows",
        supports_system_audio: true,
        supports_native_monitor_capture: true,
        supports_window_capture_exclusion: true,
        supports_click_through_prompter: true,
        supports_camera_format_discovery: true,
      });
      if (command === "list_monitors") return Promise.resolve(monitors);
      if (command === "get_recording_audio_level") return Promise.resolve({ available: false, rms: 0, peak: 0, bytes: 0 });
      if (command === "open_recording_countdown_window") {
        countdownOpens += 1;
        return Promise.resolve();
      }
      if (command === "close_recording_countdown_window") return Promise.resolve();
      if (command === "start_recording_take") {
        startCalls += 1;
        return Promise.resolve({ id: "take_1", status: "recording", scope });
      }
      return Promise.resolve();
    });

    render(<RecordingControlWindow />);

    await screen.findByText("Intro sketch");
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    await waitFor(() => expect(countdownOpens).toBe(1));

    // The user dismisses the countdown (Esc / cancel button emits the event).
    await waitFor(() => expect(typeof mocks.listeners["recording-countdown-cancel"]).toBe("function"));
    await act(async () => {
      mocks.listeners["recording-countdown-cancel"]({ payload: {} });
      await Promise.resolve();
    });

    // We are back in setup with the single-flight guard released: a fresh start
    // proceeds to a second countdown, and no native capture was ever started.
    const startButton = await screen.findByRole("button", { name: /start recording/i });
    await waitFor(() => expect(startButton).toBeEnabled());
    fireEvent.click(startButton);
    await waitFor(() => expect(countdownOpens).toBe(2));
    expect(startCalls).toBe(0);
  });

  it("ignores a countdown-cancel whose attempt id does not match the current countdown", async () => {
    mocks.settings.recorderCountdownSeconds = 5;
    let countdownOpens = 0;
    let capturedAttemptId: number | undefined;
    let startCalls = 0;
    mocks.invoke.mockImplementation((command: string, args?: { attemptId?: number }) => {
      if (command === "get_recording_control_params") return Promise.resolve({ document_title: "Intro sketch", scope });
      if (command === "get_recording_platform_capabilities") return Promise.resolve({
        platform: "windows",
        supports_system_audio: true,
        supports_native_monitor_capture: true,
        supports_window_capture_exclusion: true,
        supports_click_through_prompter: true,
        supports_camera_format_discovery: true,
      });
      if (command === "list_monitors") return Promise.resolve(monitors);
      if (command === "get_recording_audio_level") return Promise.resolve({ available: false, rms: 0, peak: 0, bytes: 0 });
      if (command === "open_recording_countdown_window") {
        countdownOpens += 1;
        capturedAttemptId = args?.attemptId;
        return Promise.resolve();
      }
      if (command === "close_recording_countdown_window") return Promise.resolve();
      if (command === "start_recording_take") {
        startCalls += 1;
        return Promise.resolve({ id: "take_1", status: "recording", scope });
      }
      return Promise.resolve();
    });

    render(<RecordingControlWindow />);

    await screen.findByText("Intro sketch");
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    await waitFor(() => expect(countdownOpens).toBe(1));
    await waitFor(() => expect(typeof mocks.listeners["recording-countdown-cancel"]).toBe("function"));
    await waitFor(() => expect(typeof capturedAttemptId).toBe("number"));

    // A stale cancel naming a different (superseded) countdown must be ignored:
    // the current countdown stays parked and the Start button stays disabled.
    await act(async () => {
      mocks.listeners["recording-countdown-cancel"]({ payload: { attemptId: (capturedAttemptId as number) + 999 } });
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: /start recording/i })).toBeDisabled();

    // The cancel that names the current attempt returns us to setup.
    await act(async () => {
      mocks.listeners["recording-countdown-cancel"]({ payload: { attemptId: capturedAttemptId } });
      await Promise.resolve();
    });
    const startButton = await screen.findByRole("button", { name: /start recording/i });
    await waitFor(() => expect(startButton).toBeEnabled());
    expect(startCalls).toBe(0);
  });

  it("discards the live capture when the window closes during the post-start resize", async () => {
    let resolveSize: () => void = () => {};
    let startInvoked = false;
    let resizeDeferred = false;
    mocks.setSize.mockImplementation(() => {
      if (startInvoked && !resizeDeferred) {
        resizeDeferred = true;
        return new Promise<void>((resolve) => { resolveSize = resolve; });
      }
      return Promise.resolve();
    });
    const preventDefault = vi.fn();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_recording_control_params") return Promise.resolve({ document_title: "Intro sketch", scope });
      if (command === "get_recording_platform_capabilities") return Promise.resolve({
        platform: "windows",
        supports_system_audio: true,
        supports_native_monitor_capture: true,
        supports_window_capture_exclusion: true,
        supports_click_through_prompter: true,
        supports_camera_format_discovery: true,
      });
      if (command === "list_monitors") return Promise.resolve(monitors);
      if (command === "get_recording_audio_level") return Promise.resolve({ available: false, rms: 0, peak: 0, bytes: 0 });
      if (command === "close_recording_countdown_window") return Promise.resolve();
      if (command === "start_recording_take") {
        startInvoked = true;
        return Promise.resolve({ id: "take_live", status: "recording", scope });
      }
      if (command === "discard_recording_take") return Promise.resolve({ id: "take_live", status: "failed", scope });
      if (command === "close_recording_control_window") return Promise.resolve();
      return Promise.resolve();
    });

    render(<RecordingControlWindow />);

    await screen.findByText("Intro sketch");
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    // The native start resolved; startTake is now parked on `await setSize(HUD)`.
    await waitFor(() => expect(resizeDeferred).toBe(true));

    // A close arrives during the resize, before the "recording" phase render is
    // guaranteed to have re-registered the close listener.
    await waitFor(() => expect(mocks.closeState.handler).toBeTypeOf("function"));
    await act(async () => {
      mocks.closeState.handler?.({ preventDefault });
      await Promise.resolve();
      await Promise.resolve();
    });

    // The installed capture is discarded rather than closed over, and success is
    // never published even after the resize finally resolves.
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("discard_recording_take"));
    await act(async () => {
      resolveSize();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.emit).not.toHaveBeenCalledWith("recording-control-started", expect.anything());
  });
});

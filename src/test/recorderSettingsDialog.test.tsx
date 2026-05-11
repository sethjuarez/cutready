import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecorderSettingsDialog } from "../components/RecorderSettingsDialog";
import { useToastStore } from "../stores/toastStore";
import type { RecordingTake } from "../types/recording";

const mockInvoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

const mockGlobalSettings = {
  recorderCaptureSource: "full_screen",
  recorderMicDeviceId: "",
  recorderCountdownSeconds: 3,
  recorderIncludeCursor: true,
  recorderOutputQuality: "lossless",
  recorderCameraEnabled: false,
  recorderSystemAudioEnabled: false,
};

vi.mock("../hooks/useSettings", () => ({
  useSettings: () => ({
    settings: mockGlobalSettings,
    updateSetting: vi.fn(),
    loaded: true,
  }),
}));

function preparedTake(): RecordingTake {
  return {
    schema_version: 1,
    id: "take_20260511_abcdef12",
    scope: { kind: "sketch", path: "intro.sk" },
    settings: {
      capture_source: "region",
      mic_device_id: null,
      countdown_seconds: 5,
      include_cursor: false,
      output_quality: "high",
    },
    status: "prepared",
    created_at: "2026-05-11T18:00:00Z",
    updated_at: "2026-05-11T18:00:00Z",
    metadata_path: ".cutready/recordings/take_20260511_abcdef12/take.json",
    assets: [],
    markers: [],
  };
}

describe("RecorderSettingsDialog", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockGlobalSettings.recorderCaptureSource = "full_screen";
    mockGlobalSettings.recorderMicDeviceId = "";
    mockGlobalSettings.recorderCountdownSeconds = 3;
    mockGlobalSettings.recorderIncludeCursor = true;
    mockGlobalSettings.recorderOutputQuality = "lossless";
    mockGlobalSettings.recorderCameraEnabled = false;
    mockGlobalSettings.recorderSystemAudioEnabled = false;
    useToastStore.setState({ toasts: [] });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("submits selected recorder settings for the document scope", async () => {
    const onPrepared = vi.fn();
    mockInvoke.mockResolvedValue(preparedTake());

    render(
      <RecorderSettingsDialog
        isOpen
        onClose={vi.fn()}
        scope={{ kind: "sketch", path: "intro.sk" }}
        documentTitle="Intro"
        onPrepared={onPrepared}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /region/i }));
    fireEvent.change(screen.getByLabelText(/countdown/i), { target: { value: "5" } });
    fireEvent.click(screen.getByLabelText(/include cursor/i));
    fireEvent.change(screen.getByLabelText(/output quality/i), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: /prepare recording/i }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("create_recording_take", {
        scope: { kind: "sketch", path: "intro.sk" },
        settings: {
          capture_source: "region",
          mic_device_id: null,
          countdown_seconds: 5,
          include_cursor: false,
          output_quality: "high",
        },
      });
    });
    expect(onPrepared).toHaveBeenCalledWith(preparedTake());
    expect(screen.getByText(/take prepared/i)).toBeInTheDocument();
  });

  it("initializes take settings from global recorder defaults", async () => {
    mockGlobalSettings.recorderCaptureSource = "window";
    mockGlobalSettings.recorderCountdownSeconds = 5;
    mockGlobalSettings.recorderIncludeCursor = false;
    mockGlobalSettings.recorderOutputQuality = "compact";
    mockInvoke.mockResolvedValue(preparedTake());

    render(
      <RecorderSettingsDialog
        isOpen
        onClose={vi.fn()}
        scope={{ kind: "storyboard", path: "demo.sb" }}
        documentTitle="Demo"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /prepare recording/i }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("create_recording_take", {
        scope: { kind: "storyboard", path: "demo.sb" },
        settings: {
          capture_source: "window",
          mic_device_id: null,
          countdown_seconds: 5,
          include_cursor: false,
          output_quality: "compact",
        },
      });
    });
  });

  it("keeps future camera and system audio controls disabled", () => {
    render(
      <RecorderSettingsDialog
        isOpen
        onClose={vi.fn()}
        scope={{ kind: "storyboard", path: "demo.sb" }}
        documentTitle="Demo"
      />,
    );

    expect(screen.getByLabelText(/camera separate asset/i)).toBeDisabled();
    expect(screen.getByLabelText(/system audio separate asset/i)).toBeDisabled();
  });

  it("disables submit while creating a take and surfaces errors", async () => {
    let rejectPrepare: (error: Error) => void = () => {};
    mockInvoke.mockReturnValue(new Promise((_resolve, reject) => { rejectPrepare = reject; }));

    render(
      <RecorderSettingsDialog
        isOpen
        onClose={vi.fn()}
        scope={{ kind: "sketch", path: "intro.sk" }}
        documentTitle="Intro"
      />,
    );

    const prepare = screen.getByRole("button", { name: /prepare recording/i });
    fireEvent.click(prepare);

    expect(screen.getByRole("button", { name: /preparing/i })).toBeDisabled();

    await act(async () => {
      rejectPrepare(new Error("scope missing"));
      await Promise.resolve();
    });

    const latestToast = useToastStore.getState().toasts[useToastStore.getState().toasts.length - 1];
    expect(screen.getByRole("button", { name: /prepare recording/i })).not.toBeDisabled();
    expect(latestToast?.type).toBe("error");
    expect(latestToast?.message).toContain("scope missing");
  });
});

import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listeners = vi.hoisted(() => new Map<string, () => void>());
const unlisten = vi.hoisted(() => vi.fn());

vi.mock("../ipc/events", () => ({
  listenEvent: vi.fn((name: string, handler: () => void) => {
    listeners.set(name, handler);
    return Promise.resolve(unlisten);
  }),
}));

import { RecordingEventsHost } from "../components/RecordingEventsHost";
import { useAppStore } from "../stores/appStore";
import { useRecordingStore } from "../stores/recordingStore";
import { useSettingsStore } from "../hooks/useSettings";

const originalApp = { ...useAppStore.getState() };
const originalRecording = { ...useRecordingStore.getState() };
const originalSettings = { ...useSettingsStore.getState() };
const project = { root: "D:\\demo", repo_root: "D:\\demo", name: "Demo" } as never;

describe("RecordingEventsHost", () => {
  const startRecording = vi.fn(() => Promise.resolve());
  const stopRecording = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    useSettingsStore.setState({ settings: { ...originalSettings.settings, featureRecording: true } });
    useAppStore.setState({ currentProject: project, loading: false });
    useRecordingStore.setState({ isBrowserReady: true, isRecording: false, startRecording, stopRecording });
  });

  afterEach(() => {
    listeners.clear();
    vi.clearAllMocks();
    useAppStore.setState(originalApp, true);
    useRecordingStore.setState(originalRecording, true);
    useSettingsStore.setState(originalSettings, true);
  });

  it("toggles recording from the hotkey event and unsubscribes on unmount", async () => {
    const { unmount } = render(<RecordingEventsHost />);
    const toggle = listeners.get("toggle-recording")!;

    toggle();
    expect(startRecording).toHaveBeenCalledTimes(1);

    useRecordingStore.setState({ isRecording: true });
    toggle();
    expect(stopRecording).toHaveBeenCalledTimes(1);

    unmount();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalled();
  });

  it("ignores the hotkey without the feature flag, a project, a prepared browser, or while loading", () => {
    render(<RecordingEventsHost />);
    const toggle = listeners.get("toggle-recording")!;

    useSettingsStore.setState({ settings: { ...originalSettings.settings, featureRecording: false } });
    toggle();
    useSettingsStore.setState({ settings: { ...originalSettings.settings, featureRecording: true } });
    useAppStore.setState({ currentProject: null });
    toggle();
    useAppStore.setState({ currentProject: project, loading: true });
    toggle();
    useAppStore.setState({ loading: false });
    useRecordingStore.setState({ isBrowserReady: false });
    toggle();

    expect(startRecording).not.toHaveBeenCalled();
    expect(stopRecording).not.toHaveBeenCalled();
  });
});

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingPrompterWindow } from "../components/RecordingPrompterWindow";

const mocks = vi.hoisted(() => {
  const listeners: Record<string, () => void> = {};
  return {
    invoke: vi.fn(),
    listen: vi.fn((event: string, handler: () => void) => {
      listeners[event] = handler;
      return Promise.resolve(() => {
        delete listeners[event];
      });
    }),
    listeners,
    setIgnoreCursorEvents: vi.fn(() => Promise.resolve()),
    setPosition: vi.fn(() => Promise.resolve()),
    outerSize: vi.fn(() => Promise.resolve({ width: 320, height: 1080 })),
    close: vi.fn(() => Promise.resolve()),
    startDragging: vi.fn(() => Promise.resolve()),
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: [string, () => void]) => mocks.listen(...args),
}));

vi.mock("@tauri-apps/api/window", () => ({
  PhysicalPosition: class PhysicalPosition {
    constructor(
      public x: number,
      public y: number,
    ) {}
  },
  getCurrentWindow: () => ({
    setIgnoreCursorEvents: mocks.setIgnoreCursorEvents,
    setPosition: mocks.setPosition,
    outerSize: mocks.outerSize,
    close: mocks.close,
    startDragging: mocks.startDragging,
  }),
}));

const prompterParams = {
  document_title: "Intro sketch",
  read_mode: false,
  monitor_x: 100,
  monitor_y: 50,
  monitor_w: 1920,
  monitor_h: 1080,
  script: {
    title: "Intro sketch",
    steps: [
      {
        title: "Intro",
        section: null,
        narrative: "**First** line",
        cue: "Click start",
        source_path: "intro.sk",
        row_index: 0,
      },
      {
        title: "Intro",
        section: null,
        narrative: "Second line",
        cue: null,
        source_path: "intro.sk",
        row_index: 1,
      },
    ],
  },
};

describe("RecordingPrompterWindow", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.invoke.mockResolvedValue(prompterParams);
  });

  afterEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mocks.listeners)) delete mocks.listeners[key];
  });

  it("renders adjust controls for backdrop opacity, text size, and side placement", async () => {
    render(<RecordingPrompterWindow />);

    await screen.findByText("First");
    expect(screen.getByRole("slider", { name: /prompter backdrop opacity/i })).toHaveValue("18");
    expect(screen.getByRole("slider", { name: /prompter text size/i })).toHaveValue("18");

    fireEvent.change(screen.getByRole("slider", { name: /prompter backdrop opacity/i }), { target: { value: "42" } });
    fireEvent.change(screen.getByRole("slider", { name: /prompter text size/i }), { target: { value: "24" } });
    fireEvent.click(screen.getByRole("button", { name: /move prompter left/i }));

    await waitFor(() => expect(window.localStorage.getItem("cutready-recording-prompter-opacity-v3")).toBe("42"));
    expect(window.localStorage.getItem("cutready-recording-prompter-text-size")).toBe("24");
    await waitFor(() => expect(mocks.setPosition).toHaveBeenCalledWith(expect.objectContaining({ x: 100, y: 50 })));
    expect(mocks.setIgnoreCursorEvents).toHaveBeenCalledWith(false);
  });

  it("opens read mode as click-through and advances through global prompter events", async () => {
    mocks.invoke.mockResolvedValue({ ...prompterParams, read_mode: true });

    render(<RecordingPrompterWindow />);

    await screen.findByText("First");
    expect(screen.queryByRole("slider", { name: /prompter backdrop opacity/i })).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.setIgnoreCursorEvents).toHaveBeenCalledWith(true));

    act(() => {
      mocks.listeners["recording-prompter-next"]?.();
    });

    expect(await screen.findByText("Second line")).toBeInTheDocument();
    act(() => {
      mocks.listeners["recording-prompter-adjust"]?.();
    });

    await waitFor(() => expect(mocks.setIgnoreCursorEvents).toHaveBeenLastCalledWith(false));
    expect(screen.getByRole("slider", { name: /prompter backdrop opacity/i })).toBeInTheDocument();
  });
});

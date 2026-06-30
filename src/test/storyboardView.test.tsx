import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoryboardView } from "../components/StoryboardView";
import { useAppStore } from "../stores/appStore";
import type { SketchSummary, Storyboard, StoryboardItem } from "../types/sketch";

const mockInvoke = vi.fn();
const mockRunBackgroundAgentAction = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

vi.mock("../utils/exportToWord", () => ({
  exportStoryboardToWord: vi.fn(),
}));

vi.mock("../hooks/useBackgroundAgentAction", () => ({
  useBackgroundAgentAction: () => mockRunBackgroundAgentAction,
}));

function activeStoryboard(description = "Original description", locked = false, items: StoryboardItem[] = []): Storyboard {
  return {
    title: "Demo Storyboard",
    description,
    locked,
    items,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function sketchSummary(title: string, path: string, row_count = 0): SketchSummary {
  return {
    title,
    path,
    row_count,
    state: "draft",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("StoryboardView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockImplementation((command: string) => {
      if (command === "update_storyboard") return Promise.resolve();
      if (command === "get_storyboard") return Promise.resolve(activeStoryboard("Updated description"));
      if (command === "set_storyboard_lock") return Promise.resolve(activeStoryboard("Original description", true));
      if (command === "list_storyboards") return Promise.resolve([]);
      return Promise.resolve([]);
    });
    useAppStore.setState({
      activeStoryboardPath: "demo.sb",
      activeStoryboard: activeStoryboard(),
      sketches: [],
      currentProject: null,
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("debounces storyboard description saves while typing", async () => {
    render(<StoryboardView />);

    fireEvent.click(screen.getByText("Original description"));
    const textarea = screen.getByPlaceholderText("Describe this storyboard...");
    textarea.focus();
    const fullDescription = "Updated description with enough words to catch remount regressions.";
    for (let i = 1; i <= fullDescription.length; i++) {
      fireEvent.change(textarea, { target: { value: fullDescription.slice(0, i) } });
      expect(document.activeElement).toBe(textarea);
    }

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "update_storyboard",
      expect.objectContaining({ description: fullDescription }),
    );

    act(() => {
      vi.advanceTimersByTime(799);
    });
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "update_storyboard",
      expect.objectContaining({ description: fullDescription }),
    );

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      "update_storyboard",
      expect.objectContaining({
        relativePath: "demo.sb",
        description: fullDescription,
      }),
    );
  });

  it("does not overwrite local typing when storyboard store updates during edit", async () => {
    render(<StoryboardView />);

    fireEvent.click(screen.getByText("Original description"));
    const textarea = screen.getByPlaceholderText("Describe this storyboard...") as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(textarea, { target: { value: "Local draft in progress" } });
    });

    act(() => {
      useAppStore.setState({
        activeStoryboard: activeStoryboard("External backend refresh"),
      });
    });

    expect(textarea.value).toBe("Local draft in progress");
    expect(document.activeElement).toBe(textarea);

    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });
  });

  it("prevents storyboard edits when locked and unlocks through the header button", async () => {
    useAppStore.setState({
      activeStoryboard: activeStoryboard("Locked description", true),
    });

    render(<StoryboardView />);

    expect(screen.queryByText("New Sketch")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Locked description"));
    expect(screen.queryByPlaceholderText("Describe this storyboard...")).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTitle("Unlock storyboard"));
      await Promise.resolve();
    });

    expect(mockInvoke).toHaveBeenCalledWith("set_storyboard_lock", {
      relativePath: "demo.sb",
      locked: false,
    });
  });

  it("toggles a section by clicking its title", () => {
    const section: StoryboardItem = {
      type: "section",
      title: "Build",
      description: "Original section framing",
      sketches: ["prototype.sk"],
    };
    useAppStore.setState({
      activeStoryboard: activeStoryboard("Original description", false, [section]),
      sketches: [sketchSummary("Prototype", "prototype.sk")],
    });

    render(<StoryboardView />);

    expect(screen.getByText("Loading sketch…")).toBeInTheDocument();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Build" }));
    });
    expect(screen.queryByText("Loading sketch…")).not.toBeInTheDocument();
  });

  it("toggles a sketch by clicking its title", async () => {
    const items: StoryboardItem[] = [{ type: "sketch_ref", path: "intro.sk" }];
    useAppStore.setState({
      activeStoryboard: activeStoryboard("Original description", false, items),
      sketches: [sketchSummary("Intro", "intro.sk")],
    });

    render(<StoryboardView />);

    expect(screen.getByText("Loading sketch…")).toBeInTheDocument();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Intro" }));
    });
    expect(screen.queryByText("Loading sketch…")).not.toBeInTheDocument();
  });

  it("edits section titles from the pencil without saving the description", async () => {
    const section: StoryboardItem = {
      type: "section",
      title: "Build",
      description: "Original section framing",
      sketches: [],
    };
    useAppStore.setState({
      activeStoryboard: activeStoryboard("Original description", false, [section]),
    });

    render(<StoryboardView />);

    const description = screen.getByDisplayValue("Original section framing");
    fireEvent.change(description, {
      target: { value: "Updated section framing" },
    });
    fireEvent.click(screen.getByLabelText("Edit section title: Build"));
    const title = screen.getByDisplayValue("Build");
    fireEvent.change(title, {
      target: { value: "Build chapter" },
    });
    await act(async () => {
      fireEvent.blur(title);
      await Promise.resolve();
    });

    expect(mockInvoke).toHaveBeenCalledWith("reorder_storyboard_items", {
      storyboardPath: "demo.sb",
      items: [expect.objectContaining({
        type: "section",
        title: "Build chapter",
        description: "Original section framing",
      })],
    });
  });

  it("removes a storyboard section", async () => {
    const items: StoryboardItem[] = [
      { type: "sketch_ref", path: "intro.sk" },
      {
        type: "section",
        title: "Build",
        description: "Original section framing",
        sketches: ["prototype.sk", "deploy.sk"],
      },
    ];
    useAppStore.setState({
      activeStoryboard: activeStoryboard("Original description", false, items),
    });

    render(<StoryboardView />);

    fireEvent.click(screen.getByTitle("Remove section"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Remove section?")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(dialog).getByText("Remove"));
      await Promise.resolve();
    });

    expect(mockInvoke).toHaveBeenCalledWith("reorder_storyboard_items", {
      storyboardPath: "demo.sb",
      items: [{ type: "sketch_ref", path: "intro.sk" }],
    });
  });

  it("offers AI improvement for section descriptions", async () => {
    const section: StoryboardItem = {
      type: "section",
      title: "Build",
      description: "Original section framing",
      sketches: [],
    };
    useAppStore.setState({
      activeStoryboard: activeStoryboard("Original description", false, [section]),
    });

    render(<StoryboardView />);

    await act(async () => {
      fireEvent.click(screen.getByTitle("Improve section description with AI"));
      await Promise.resolve();
    });

    expect(mockRunBackgroundAgentAction).toHaveBeenCalledWith(
      expect.stringContaining('Improve the description for section "Build" at index 0'),
      { label: "Improve section description" },
    );
  });
});

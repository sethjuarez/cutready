import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoryboardView } from "../components/StoryboardView";
import { useAppStore } from "../stores/appStore";
import type { Storyboard } from "../types/sketch";

const mockInvoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("../utils/exportToWord", () => ({
  exportStoryboardToWord: vi.fn(),
}));

function activeStoryboard(description = "Original description", locked = false): Storyboard {
  return {
    title: "Demo Storyboard",
    description,
    locked,
    items: [],
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
});

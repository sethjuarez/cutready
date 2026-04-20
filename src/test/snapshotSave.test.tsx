import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  Channel: class {},
}));

import { SnapshotDialog } from "../components/SnapshotDialog";
import { useAppStore } from "../stores/appStore";

const originalSaveVersion = useAppStore.getState().saveVersion;

describe("snapshot save naming flow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockInvoke.mockReset();
    act(() => {
      useAppStore.setState({
        snapshotPromptOpen: false,
        identityPromptOpen: false,
        identityPromptCallback: null,
        pendingNavAfterSave: null,
        isRewound: false,
        saving: false,
        saveVersion: originalSaveVersion,
      });
    });
  });

  it("quickSave opens the naming prompt instead of creating an auto-named snapshot", async () => {
    mockInvoke.mockResolvedValue({ name: "CutReady", email: "app@cutready.local", is_fallback: false });

    await useAppStore.getState().quickSave();

    expect(useAppStore.getState().snapshotPromptOpen).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith("check_git_identity");
    expect(mockInvoke).not.toHaveBeenCalledWith("save_with_label", expect.anything());
  });

  it("canceling the snapshot dialog does not save", async () => {
    const saveVersion = vi.fn();
    act(() => {
      useAppStore.setState({
        snapshotPromptOpen: true,
        saveVersion,
      });
    });

    render(<SnapshotDialog />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(saveVersion).not.toHaveBeenCalled();
    expect(useAppStore.getState().snapshotPromptOpen).toBe(false);
  });
});

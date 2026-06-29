import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type CloseEvent = { preventDefault: ReturnType<typeof vi.fn> };
type CloseHandler = (event: CloseEvent) => void;

const windowMock = vi.hoisted(() => {
  const close = vi.fn(() => Promise.resolve());
  const unlisten = vi.fn();
  let handler: CloseHandler | null = null;
  return {
    close,
    unlisten,
    setHandler: (next: CloseHandler | null) => { handler = next; },
    triggerClose: () => {
      const event = { preventDefault: vi.fn() };
      handler?.(event);
      return event;
    },
  };
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: windowMock.close,
    onCloseRequested: (handler: CloseHandler) => {
      windowMock.setHandler(handler);
      return Promise.resolve(windowMock.unlisten);
    },
  }),
}));

import { AppCloseGuard } from "../components/AppCloseGuard";
import { useAppStore } from "../stores/appStore";

const project = {
  root: "D:\\workspace\\demo",
  repo_root: "D:\\workspace",
  name: "Demo",
};

describe("AppCloseGuard", () => {
  afterEach(() => {
    windowMock.close.mockClear();
    windowMock.unlisten.mockClear();
    windowMock.setHandler(null);
    act(() => {
      useAppStore.setState({
        currentProject: null,
        isDirty: false,
        isMerging: false,
        snapshotPromptOpen: false,
        mergeConflicts: [],
        draftlineMergeToken: null,
        draftlineMergeRemote: null,
      });
    });
  });

  it("requires a decision before closing with unsaved snapshot changes", async () => {
    act(() => {
      useAppStore.setState({ currentProject: project, isDirty: true });
    });
    render(<AppCloseGuard />);
    await act(async () => undefined);

    let event: ReturnType<typeof windowMock.triggerClose>;
    act(() => {
      event = windowMock.triggerClose();
    });

    expect(event!.preventDefault).toHaveBeenCalled();
    expect(await screen.findByText("Quit with unsaved snapshot?")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Save snapshot first" }));
    });

    expect(useAppStore.getState().snapshotPromptOpen).toBe(true);
    expect(windowMock.close).not.toHaveBeenCalled();
  });

  it("can cancel an in-progress merge and then close", async () => {
    act(() => {
      useAppStore.setState({ currentProject: project, isMerging: true });
    });
    render(<AppCloseGuard />);
    await act(async () => undefined);

    let event: ReturnType<typeof windowMock.triggerClose>;
    act(() => {
      event = windowMock.triggerClose();
    });

    expect(event!.preventDefault).toHaveBeenCalled();
    expect(await screen.findByText("Finish merge before closing?")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel merge and quit" }));
    });

    expect(useAppStore.getState().isMerging).toBe(false);
    expect(windowMock.close).toHaveBeenCalledTimes(1);
  });

  it("falls through to the dirty close gate after canceling a merge", async () => {
    act(() => {
      useAppStore.setState({ currentProject: project, isMerging: true, isDirty: true });
    });
    render(<AppCloseGuard />);
    await act(async () => undefined);

    let event: ReturnType<typeof windowMock.triggerClose>;
    act(() => {
      event = windowMock.triggerClose();
    });

    expect(event!.preventDefault).toHaveBeenCalled();
    expect(await screen.findByText("Finish merge before closing?")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel merge and quit" }));
    });

    expect(useAppStore.getState().isMerging).toBe(false);
    expect(windowMock.close).not.toHaveBeenCalled();
    expect(await screen.findByText("Quit with unsaved snapshot?")).toBeInTheDocument();
  });
});

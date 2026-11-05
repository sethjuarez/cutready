import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const clipboard = vi.hoisted(() => ({ markdown: vi.fn(), create: vi.fn() }));
const ipc = vi.hoisted(() => ({ toNote: vi.fn(), sketch: vi.fn(), storyboard: vi.fn(), videoWithProgress: vi.fn() }));

vi.mock("../services/tauri", () => ({
  invoke: vi.fn(async () => null),
  listen: vi.fn(),
  once: vi.fn(),
  emit: vi.fn(),
  emitTo: vi.fn(),
  convertFileSrc: vi.fn((path: string) => path),
  Channel: class {},
}));
vi.mock("../components/import/clipboardNote", () => ({
  clipboardMarkdown: clipboard.markdown,
  createUniqueNote: clipboard.create,
}));
vi.mock("../ipc/workspace", async (original) => ({
  ...(await original<typeof import("../ipc/workspace")>()),
  importIpc: ipc,
}));
vi.mock("../components/import/useVideoImportLlmConfig", () => ({ useVideoImportLlmConfig: () => async () => null }));

import { useProjectImport } from "../components/import/useProjectImport";
import { useAppStore } from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";

const projectAt = (root: string) => ({ root, name: root }) as unknown as ReturnType<typeof useAppStore.getState>["currentProject"];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  act(() => useAppStore.setState({ currentProject: null }));
});

describe("useProjectImport project binding", () => {
  it("doesn't write a pasted note into a project opened during clipboard conversion", async () => {
    act(() => useAppStore.setState({ currentProject: projectAt("/a") }));
    const show = vi.spyOn(useToastStore.getState(), "show");
    clipboard.markdown.mockImplementation(async () => {
      act(() => useAppStore.setState({ currentProject: projectAt("/b") }));
      return "# pasted";
    });
    const { result } = renderHook(() => useProjectImport());
    await act(() => result.current.run({ kind: "clipboard", projectRoot: "/a" }));
    expect(clipboard.create).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith("Import stopped because the project changed.", 5000, "warning");
    show.mockRestore();
  });

  it("cancels the planning-context dialog when the project changes, so the run finishes", async () => {
    act(() => useAppStore.setState({ currentProject: projectAt("/a") }));
    const { result } = renderHook(() => useProjectImport());
    let done = false;
    act(() => {
      void result.current.run({ kind: "paths", paths: ["take.mp4"], projectRoot: "/a" }).then(() => { done = true; });
    });
    await waitFor(() => expect(result.current.videoContext.open).toBe(true));
    act(() => useAppStore.setState({ currentProject: projectAt("/b") }));
    await waitFor(() => expect(done).toBe(true));
    expect(result.current.videoContext.open).toBe(false);
    expect(ipc.videoWithProgress).not.toHaveBeenCalled();
  });

  it("stops before the next file once the project changes", async () => {
    act(() => useAppStore.setState({ currentProject: projectAt("/a") }));
    ipc.toNote.mockImplementation(async () => {
      act(() => useAppStore.setState({ currentProject: projectAt("/b") }));
      return "one.md";
    });
    const { result } = renderHook(() => useProjectImport());
    await act(() => result.current.run({ kind: "paths", paths: ["one.md", "two.md"], projectRoot: "/a" }));
    expect(ipc.toNote).toHaveBeenCalledTimes(1);
  });
});

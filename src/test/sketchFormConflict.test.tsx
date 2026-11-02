import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), createCopy: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve([])),
  Channel: class {},
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }));
vi.mock("../ipc/documents", () => ({ documentsIpc: ipc }));
vi.mock("../hooks/useSettings", () => ({ useSettings: () => ({ settings: {}, updateSetting: vi.fn() }) }));
vi.mock("../components/ProjectImage", () => ({ ProjectImage: () => null }));
vi.mock("../components/VisualCell", () => ({ default: () => null }));

import { SketchForm } from "../components/SketchForm";
import { INSTALL_SETTLE_MS, isDocumentConflict, loadDocument, saveDocument } from "../services/documentSaves";
import { useAppStore } from "../stores/appStore";
import { resetDocumentVersions } from "../stores/documentVersionStore";
import type { ProjectView } from "../types/project";
import type { Sketch } from "../types/sketch";

const PATH = "demo.sk";
const ROWS = [{ id: "r1", time: "", duration_seconds: null, narrative: "intro", demo_actions: "", screenshot: null }];
const sketch = (title: string, description = "") =>
  ({ title, description, rows: ROWS, created_at: "", updated_at: "" }) as unknown as Sketch;
const versioned = (document: Sketch, version: string) => ({ document, content: JSON.stringify(document), version, merged: false });
const settle = () => new Promise((resolve) => setTimeout(resolve, INSTALL_SETTLE_MS + 20));

beforeEach(() => {
  resetDocumentVersions();
  ipc.read.mockReset();
  ipc.save.mockReset();
  ipc.createCopy.mockReset();
  useAppStore.setState({
    currentProject: { root: "D:\\demo", name: "demo" } as unknown as ProjectView,
    openTabs: [{ id: `main:sketch:${PATH}`, type: "sketch", path: PATH, title: "Demo" }],
    splitTabs: [],
    activeSketchPath: PATH,
    activeSketch: sketch("v0", "base"),
  });
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ currentProject: null, openTabs: [], activeSketchPath: null, activeSketch: null });
});

describe("main sketch editor during a conflict", () => {
  it("refuses the conflict reload while a description draft is pending, so the draft goes to the copy", async () => {
    ipc.read.mockResolvedValueOnce(versioned(sketch("v0", "base"), "h0"));
    await loadDocument("sketch", PATH);
    await settle();
    render(<SketchForm />);

    const saves: Array<{ path: unknown; args: Record<string, unknown> }> = [];
    ipc.save.mockImplementation((_: string, args: Record<string, unknown>) => {
      saves.push({ path: args.relativePath, args });
      if (args.relativePath === PATH && args.title === "mine") return Promise.reject({ code: "stale_document" });
      return Promise.resolve(versioned(sketch("saved"), `v${saves.length}`));
    });
    ipc.createCopy.mockResolvedValue(versioned(sketch(""), "c0"));
    let finishReload!: (value: unknown) => void;
    ipc.read.mockReturnValueOnce(new Promise((resolve) => (finishReload = resolve)));
    ipc.read.mockResolvedValue(versioned(sketch("theirs", "their description"), "h9"));

    await expect(saveDocument("update_sketch_title", { relativePath: PATH, title: "mine" })).rejects.toSatisfy(isDocumentConflict);
    const copyPath = ipc.createCopy.mock.calls[0][0] as string;
    await waitFor(() => expect(ipc.read).toHaveBeenCalledTimes(2));

    // The user types a description while the reload reads the document; the draft waits for its debounce.
    fireEvent.click(screen.getByRole("button", { name: "Sketch description" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Sketch description" }), { target: { value: "typed" } });
    await act(async () => finishReload(versioned(sketch("theirs", "their description"), "h9")));

    // The redirect stays: the description draft is saved to the copy, not the document.
    await waitFor(() => expect(saves.some((save) => save.args.description === "typed")).toBe(true));
    expect(saves.filter((save) => save.args.description === "typed").map((save) => save.path)).toEqual([copyPath]);

    // Once the draft is saved the reload is accepted, and saves go to the document again.
    await settle();
    await waitFor(() => expect(useAppStore.getState().activeSketch?.title).toBe("theirs"));
    await saveDocument("update_sketch_title", { relativePath: PATH, title: "after" });
    expect(saves[saves.length - 1]).toMatchObject({ path: PATH, args: { title: "after", expectedVersion: "h9" } });
    expect(saves.filter((save) => save.args.description === "typed").map((save) => save.path)).toEqual([copyPath]);
  });
});
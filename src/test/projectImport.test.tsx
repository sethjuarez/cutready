import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/tauri", () => ({
  invoke: vi.fn(async () => null),
  listen: vi.fn(),
  once: vi.fn(),
  emit: vi.fn(),
  emitTo: vi.fn(),
  convertFileSrc: vi.fn((path: string) => path),
  Channel: class {},
}));

import {
  containsVideo,
  importTarget,
  noteNameCandidates,
  noteStem,
  partitionImportable,
  skippedFilesMessage,
} from "../components/import/importRouting";
import { ImportNavRow } from "../components/import/ImportNavRow";
import { useImportCommand } from "../components/import/useImportCommand";
import { handleFileDrop } from "../hooks/useFileDropImport";
import { readClipboardContent } from "../services/clipboardContent";
import { commandRegistry } from "../services/commandRegistry";
import { useAppStore } from "../stores/appStore";
import { useImportStore } from "../stores/importStore";
import { useToastStore } from "../stores/toastStore";

const project = { root: "/p", name: "p" } as unknown as ReturnType<typeof useAppStore.getState>["currentProject"];

afterEach(() => {
  cleanup();
  document.getElementById("app-sidebar")?.remove();
  vi.unstubAllGlobals();
  act(() => {
    useAppStore.setState({ currentProject: null });
    useImportStore.setState({ busy: false, pending: null, dropActive: false });
  });
});

describe("import routing", () => {
  it("routes files by extension, ignoring case", () => {
    expect(importTarget("C:\\a\\intro.SK")).toEqual({ kind: "sketch" });
    expect(importTarget("/a/show.sb")).toEqual({ kind: "storyboard" });
    expect(importTarget("notes.md")).toEqual({ kind: "note", command: "import_markdown" });
    expect(importTarget("old.doc")).toEqual({ kind: "note", command: "import_docx" });
    expect(importTarget("spec.PDF")).toEqual({ kind: "note", command: "import_pdf" });
    expect(importTarget("deck.pptx")).toEqual({ kind: "note", command: "import_pptx" });
    expect(importTarget("take.MOV")).toEqual({ kind: "video" });
  });

  it("rejects unknown, extensionless and dot files", () => {
    expect(importTarget("photo.png")).toBeNull();
    expect(importTarget("README")).toBeNull();
    expect(importTarget("/a/.md")).toBeNull();
    expect(importTarget("/a.md/file")).toBeNull();
  });

  it("partitions paths in order and spots videos", () => {
    expect(partitionImportable(["a.md", "b.png", "c.mp4", "d.zip"])).toEqual({
      supported: ["a.md", "c.mp4"],
      unsupported: ["b.png", "d.zip"],
    });
    expect(containsVideo(["a.md", "c.webm"])).toBe(true);
    expect(containsVideo(["a.md"])).toBe(false);
  });

  it("makes note stems and numbered candidates", () => {
    expect(noteStem("C:\\docs\\Q3 Plan.docx")).toBe("q3-plan");
    expect(noteStem("!!!", "imported-clipboard")).toBe("imported-clipboard");
    expect([...noteNameCandidates("n", 3)]).toEqual(["n.md", "n-2.md", "n-3.md"]);
  });

  it("names skipped files plainly", () => {
    expect(skippedFilesMessage(["/x/a.png"])).toBe("Skipped a.png: CutReady can't import this file type.");
    expect(skippedFilesMessage(["a.png", "b.zip", "c.exe", "d.iso"])).toBe(
      "Skipped a.png, b.zip, c.exe and 1 more: CutReady can't import these file types.",
    );
  });
});

describe("import store", () => {
  it("accepts one request at a time, bound to its project", () => {
    const { requestImport } = useImportStore.getState();
    expect(requestImport({ kind: "files" }, null)).toBe(false);
    expect(requestImport({ kind: "files" }, "/p")).toBe(true);
    expect(requestImport({ kind: "video" }, "/p")).toBe(false);
    expect(useImportStore.getState().take()).toEqual({ kind: "files", projectRoot: "/p" });
    expect(useImportStore.getState().busy).toBe(true);
    useImportStore.getState().finish();
    expect(useImportStore.getState().busy).toBe(false);
  });
});

describe("clipboard content", () => {
  it("falls back to plain text when rich reads are refused", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { read: vi.fn(async () => { throw new Error("denied"); }), readText: vi.fn(async () => "hello") },
    });
    await expect(readClipboardContent()).resolves.toMatchObject({ html: "", plain: "hello", image: null });
  });
});

describe("ImportNavRow", () => {
  it("is hidden without a project", () => {
    render(<ImportNavRow />);
    expect(screen.queryByTestId("explorer-import-menu")).toBeNull();
  });

  it("requests a file import on click and shows the busy state", () => {
    act(() => useAppStore.setState({ currentProject: project }));
    render(<ImportNavRow />);
    fireEvent.click(screen.getByTestId("explorer-import-menu"));
    expect(useImportStore.getState().pending).toEqual({ kind: "files", projectRoot: "/p" });
    const button = screen.getByTestId("explorer-import-menu");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveTextContent("Importing…");
  });

  it("offers the other sources in an accessible menu", () => {
    act(() => useAppStore.setState({ currentProject: project }));
    render(<ImportNavRow />);
    const more = screen.getByRole("button", { name: "More import options" });
    expect(more).toHaveAttribute("aria-haspopup", "menu");
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Files…",
      "Video as sketch…",
      "Paste from clipboard…",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: /Paste from clipboard/ }));
    expect(useImportStore.getState().pending).toEqual({ kind: "clipboard", projectRoot: "/p" });
  });
});

describe("palette command", () => {
  it("registers Import… only while a project is open", () => {
    const has = () => commandRegistry.getAll().some((command) => command.id === "project.import");
    const { rerender, unmount } = renderHook(() => useImportCommand());
    expect(has()).toBe(false);
    act(() => useAppStore.setState({ currentProject: project }));
    rerender();
    expect(has()).toBe(true);
    commandRegistry.getAll().find((command) => command.id === "project.import")!.handler();
    expect(useImportStore.getState().pending).toEqual({ kind: "files", projectRoot: "/p" });
    unmount();
    expect(has()).toBe(false);
  });
});

describe("file drops", () => {
  function sidebar(expanded = true) {
    const el = document.createElement("div");
    el.id = "app-sidebar";
    el.dataset.expanded = String(expanded);
    el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 600, width: 200, height: 600, x: 0, y: 0, toJSON() {} });
    document.body.appendChild(el);
  }

  it("highlights and imports supported files dropped on the sidebar", () => {
    sidebar();
    const show = vi.spyOn(useToastStore.getState(), "show");
    act(() => useAppStore.setState({ currentProject: project }));
    handleFileDrop({ type: "over", x: 50, y: 50 });
    expect(useImportStore.getState().dropActive).toBe(true);
    handleFileDrop({ type: "drop", x: 50, y: 50, paths: ["a.md", "b.png"] });
    expect(useImportStore.getState().dropActive).toBe(false);
    expect(show).toHaveBeenCalledWith(expect.stringContaining("b.png"), 5000, "warning");
    expect(useImportStore.getState().pending).toEqual({ kind: "paths", paths: ["a.md"], projectRoot: "/p" });
    show.mockRestore();
  });

  it("ignores drops outside the sidebar, on a collapsed sidebar, while busy or without a project", () => {
    sidebar();
    handleFileDrop({ type: "drop", x: 50, y: 50, paths: ["a.md"] });
    expect(useImportStore.getState().pending).toBeNull();

    act(() => useAppStore.setState({ currentProject: project }));
    handleFileDrop({ type: "over", x: 500, y: 50 });
    expect(useImportStore.getState().dropActive).toBe(false);
    handleFileDrop({ type: "drop", x: 500, y: 50, paths: ["a.md"] });
    expect(useImportStore.getState().pending).toBeNull();

    act(() => useImportStore.setState({ busy: true }));
    handleFileDrop({ type: "drop", x: 50, y: 50, paths: ["a.md"] });
    expect(useImportStore.getState().pending).toBeNull();

    act(() => useImportStore.setState({ busy: false }));
    document.getElementById("app-sidebar")!.dataset.expanded = "false";
    handleFileDrop({ type: "drop", x: 50, y: 50, paths: ["a.md"] });
    expect(useImportStore.getState().pending).toBeNull();
  });

  it("clears the highlight when the drag leaves", () => {
    sidebar();
    act(() => useAppStore.setState({ currentProject: project }));
    handleFileDrop({ type: "over", x: 50, y: 50 });
    handleFileDrop({ type: "leave" });
    expect(useImportStore.getState().dropActive).toBe(false);
  });
});

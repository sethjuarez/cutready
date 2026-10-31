/**
 * Tests for exportToWord: Markdown construction and the backend handoff.
 * DOCX rendering itself is covered by the Rust word_export tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSave = vi.fn();
vi.mock("../dialogs", () => ({ save: (...args: unknown[]) => mockSave(...args) }));

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mockInvoke(...args), convertFileSrc: (p: string) => p }));

const mockOpenPath = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: (...args: unknown[]) => mockOpenPath(...args) }));

const mockRenderToPng = vi.fn();
vi.mock("@elucim/dsl", () => ({
  toRenderableDocument: (doc: unknown) => doc,
  renderToPng: (...args: unknown[]) => mockRenderToPng(...args),
}));

import {
  describeWordExport,
  escapeMarkdownText,
  exportNoteToWord,
  exportSketchToWord,
  exportStoryboardToWord,
  toTableCell,
} from "../utils/exportToWord";
import type { Sketch, Storyboard } from "../types/sketch";

const REPORT = { imagesEmbedded: 0, skippedRemoteImages: [] as string[] };

function makeSketch(title = "Test Sketch", rowCount = 2): Sketch {
  return {
    title,
    description: "A test description",
    rows: Array.from({ length: rowCount }, (_, i) => ({
      time: `0:${String(i * 15).padStart(2, "0")}`,
      narrative: `Step ${i + 1} narrative`,
      demo_actions: `Action ${i + 1}`,
      screenshot: null,
    })),
    state: "draft",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
  } as Sketch;
}

function exportCall() {
  const call = mockInvoke.mock.calls.find(([cmd]) => cmd === "export_markdown_to_word");
  expect(call).toBeDefined();
  return call![1] as { markdown: string; outputPath: string; orientation: string; maxImageWidthPx: number };
}

beforeEach(() => {
  mockSave.mockReset().mockResolvedValue("/tmp/test.docx");
  mockOpenPath.mockReset().mockResolvedValue(undefined);
  mockRenderToPng.mockReset().mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  mockInvoke.mockReset().mockImplementation((cmd: string) => {
    if (cmd === "get_visual") {
      return Promise.resolve({ root: { type: "group", width: 640, height: 360, durationInFrames: 60, children: [] } });
    }
    if (cmd === "export_markdown_to_word") return Promise.resolve(REPORT);
    return Promise.resolve(undefined);
  });
});

describe("toTableCell", () => {
  it("flattens multi-line markdown into one inline GFM cell", () => {
    expect(toTableCell("## Goal\n- click **Save**\n* open menu\n\nDone")).toBe(
      "**Goal**<br>• click **Save**<br>• open menu<br>Done",
    );
  });

  it("escapes pipes, raw HTML, and math delimiters but leaves code spans alone", () => {
    expect(toTableCell("a | b \\| c <div> $5 `x<$y`")).toBe("a \\| b \\| c \\<div> \\$5 `x<$y`");
  });

  it("uses an em dash for empty cells", () => {
    expect(toTableCell("")).toBe("—");
    expect(toTableCell(null)).toBe("—");
  });

  it("leaves multi-backtick code spans literal except for pipes", () => {
    expect(toTableCell("run ``a`$b<c|d`` then $x")).toBe("run ``a`$b<c\\|d`` then \\$x");
  });

  it("keeps escape parity before pipes", () => {
    expect(toTableCell("a \\\\| b")).toBe("a \\\\\\| b");
  });

  it("doubles a trailing lone backslash so <br> survives", () => {
    expect(toTableCell("path C:\\\nnext")).toBe("path C:\\\\<br>next");
  });

  it("does not treat an unmatched backtick as a code span", () => {
    expect(toTableCell("a ` <b> | c")).toBe("a ` \\<b> \\| c");
  });
});

describe("escapeMarkdownText", () => {
  it("escapes markdown syntax in titles", () => {
    expect(escapeMarkdownText("# Q1 *launch* [draft]")).toBe("\\# Q1 \\*launch\\* \\[draft\\]");
  });
});

describe("exportSketchToWord", () => {
  it("sends a planning table to the backend and opens the result", async () => {
    const report = await exportSketchToWord(makeSketch("My Demo"));

    expect(mockSave).toHaveBeenCalledWith({
      defaultPath: "My-Demo.docx",
      filters: [{ name: "Word Document", extensions: ["docx"] }],
    });
    const call = exportCall();
    expect(call.outputPath).toBe("/tmp/test.docx");
    expect(call.orientation).toBe("landscape");
    expect(call.maxImageWidthPx).toBe(240);
    expect(call.markdown).toContain("# My Demo");
    expect(call.markdown).toContain("2 scenes");
    expect(call.markdown).toContain("A test description");
    expect(call.markdown).toContain("| Time | Narrative | Demo Actions |");
    expect(call.markdown).not.toContain("Visual / Screenshot");
    expect(call.markdown).toContain("| 0:15 | Step 2 narrative | Action 2 |");
    expect(mockOpenPath).toHaveBeenCalledWith("/tmp/test.docx");
    expect(report).toEqual(REPORT);
  });

  it("links screenshots with angle-bracket destinations so spaces survive", async () => {
    const sketch = makeSketch("Shots", 2);
    sketch.rows[0].screenshot = ".cutready\\screenshots\\my shot.png";

    await exportSketchToWord(sketch, "portrait");

    const { markdown, orientation } = exportCall();
    expect(orientation).toBe("portrait");
    expect(markdown).toContain("| Time | Narrative | Demo Actions | Visual / Screenshot |");
    expect(markdown).toContain("![Screenshot](<.cutready/screenshots/my shot.png>)");
    expect(markdown).toContain("| Action 2 | — |");
  });

  it("embeds visuals as offline PNG data URLs", async () => {
    const sketch = makeSketch("Visuals", 1);
    sketch.rows[0].visual = ".cutready/visuals/v1.json";

    await exportSketchToWord(sketch);

    expect(mockInvoke).toHaveBeenCalledWith("get_visual", { relativePath: ".cutready/visuals/v1.json" });
    expect(mockRenderToPng).toHaveBeenCalledWith(expect.anything(), 59, expect.objectContaining({ scale: 2 }));
    expect(exportCall().markdown).toContain("![Visual](<data:image/png;base64,iVBORw==>)");
  });

  it("fails loudly when a visual cannot be rendered", async () => {
    const sketch = makeSketch("Broken", 1);
    sketch.rows[0].visual = ".cutready/visuals/missing.json";
    mockRenderToPng.mockRejectedValueOnce(new Error("boom"));

    await expect(exportSketchToWord(sketch)).rejects.toThrow("Could not render visual .cutready/visuals/missing.json: boom");
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("returns null without calling the backend when the save dialog is cancelled", async () => {
    mockSave.mockResolvedValue(null);

    expect(await exportSketchToWord(makeSketch())).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalledWith("export_markdown_to_word", expect.anything());
    expect(mockOpenPath).not.toHaveBeenCalled();
  });

  it("propagates backend export errors", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "export_markdown_to_word" ? Promise.reject("missing image") : Promise.resolve(undefined));

    await expect(exportSketchToWord(makeSketch())).rejects.toBe("missing image");
    expect(mockOpenPath).not.toHaveBeenCalled();
  });
});

describe("exportStoryboardToWord", () => {
  it("orders sections and sketches with nested headings", async () => {
    const intro = makeSketch("Intro", 1);
    const demo = makeSketch("Demo", 3);
    const storyboard: Storyboard = {
      title: "Full Demo Storyboard",
      description: "End-to-end walkthrough",
      items: [
        { type: "sketch_ref", path: "sketches/intro.sk" },
        { type: "section", title: "Main Content", description: "Show the core workflow.", sketches: ["sketches/demo.sk"] },
      ],
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    } as Storyboard;

    await exportStoryboardToWord(storyboard, async () => new Map([
      ["sketches/intro.sk", intro],
      ["sketches/demo.sk", demo],
    ]));

    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "Full-Demo-Storyboard.docx" }));
    const { markdown } = exportCall();
    expect(markdown).toContain("2 sketches, 4 scenes");
    const order = ["# Full Demo Storyboard", "End-to-end walkthrough", "## Intro", "## Main Content", "Show the core workflow.", "### Demo"]
      .map((text) => markdown.indexOf(text));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("handles a storyboard with no items", async () => {
    const storyboard = {
      title: "Empty Board",
      description: "",
      items: [],
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    } as Storyboard;

    await exportStoryboardToWord(storyboard, async () => new Map());

    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "Empty-Board.docx" }));
    expect(exportCall().markdown).toContain("0 sketches, 0 scenes");
  });
});

describe("exportNoteToWord", () => {
  it("passes note markdown through with a title and portrait default", async () => {
    const body = "## Intro\n\n![shot](.cutready/screenshots/a b.png)\n\n| A | B |\n| - | - |\n| 1 | 2 |";

    await exportNoteToWord("My Notes", body);

    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "My-Notes.docx" }));
    const call = exportCall();
    expect(call.orientation).toBe("portrait");
    expect(call.maxImageWidthPx).toBe(600);
    expect(call.markdown.startsWith("# My Notes\n\n*Exported ")).toBe(true);
    expect(call.markdown.endsWith(body)).toBe(true);
  });

  it("falls back to a safe filename", async () => {
    await exportNoteToWord("???", "Body");
    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "export.docx" }));
  });
});

describe("describeWordExport", () => {
  it("warns when remote images were skipped", () => {
    expect(describeWordExport(REPORT)).toEqual({ message: "Exported to Word", type: "success" });
    expect(describeWordExport({ imagesEmbedded: 1, skippedRemoteImages: ["https://x/a.png"] })).toEqual({
      message: "Exported to Word. 1 remote image was not embedded.",
      type: "warning",
    });
  });
});

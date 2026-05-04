import { describe, it, expect, vi } from "vitest";
import { copyTabPath, getTabCopyPath } from "../components/TabBar";

describe("getTabCopyPath", () => {
  it("returns the project-relative path for a sketch tab", () => {
    expect(getTabCopyPath({ type: "sketch", path: "intro.sk" })).toBe("intro.sk");
  });

  it("returns the project-relative path for a note tab", () => {
    expect(getTabCopyPath({ type: "note", path: "planning-notes.md" })).toBe("planning-notes.md");
  });

  it("returns the project-relative path for a storyboard tab", () => {
    expect(getTabCopyPath({ type: "storyboard", path: "demo-storyboard.sb" })).toBe("demo-storyboard.sb");
  });

  it("returns the project-relative path for an asset tab", () => {
    expect(getTabCopyPath({ type: "asset", path: "screenshots/demo.png" })).toBe("screenshots/demo.png");
  });

  it("returns null for the synthetic history tab", () => {
    expect(getTabCopyPath({ type: "history", path: "__history__" })).toBeNull();
  });

  it("returns null for tabs with no path", () => {
    expect(getTabCopyPath({ type: "sketch", path: "" })).toBeNull();
  });

  it("returns null for tabs with synthetic __ paths", () => {
    expect(getTabCopyPath({ type: "sketch", path: "__virtual__" })).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(getTabCopyPath(null)).toBeNull();
    expect(getTabCopyPath(undefined)).toBeNull();
  });
});

describe("copyTabPath", () => {
  it("writes the sketch tab's project-relative path to the clipboard and toasts success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const showToast = vi.fn();
    const ok = await copyTabPath(
      { type: "sketch", path: "intro.sk" },
      { writeText, showToast },
    );
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith("intro.sk");
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("intro.sk"), expect.any(Number), "success");
  });

  it("writes the note tab's project-relative path to the clipboard and toasts success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const showToast = vi.fn();
    const ok = await copyTabPath(
      { type: "note", path: "planning-notes.md" },
      { writeText, showToast },
    );
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith("planning-notes.md");
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("planning-notes.md"), expect.any(Number), "success");
  });

  it("does nothing for a non-file-backed history tab", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const showToast = vi.fn();
    const ok = await copyTabPath(
      { type: "history", path: "__history__" },
      { writeText, showToast },
    );
    expect(ok).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("toasts an error when the clipboard write fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const showToast = vi.fn();
    const ok = await copyTabPath(
      { type: "sketch", path: "intro.sk" },
      { writeText, showToast },
    );
    expect(ok).toBe(false);
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/failed/i), expect.any(Number), "error");
  });
});

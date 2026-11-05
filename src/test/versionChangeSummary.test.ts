import { beforeEach, describe, expect, it, vi } from "vitest";

const diffVersions = vi.fn();
const previewVersionFile = vi.fn();
vi.mock("../services/draftlineVersioning", () => ({
  facade: () => ({ diffVersions, previewVersionFile }),
  requireWorkspacePath: () => "/ws",
}));

import { clearVersionChangeSummaryCache, loadVersionChangeSummary } from "../services/versionChangeSummary";

const sketch = (rows: string[]) => JSON.stringify({ title: "Intro", rows: rows.map((id) => ({ id, narrative: id })) });

describe("loadVersionChangeSummary", () => {
  beforeEach(() => {
    clearVersionChangeSummaryCache();
    diffVersions.mockReset();
    previewVersionFile.mockReset();
  });

  it("maps Draftline file kinds and reads both sides of edited documents", async () => {
    diffVersions.mockResolvedValue({
      files: [
        { path: "intro.sk", kind: "Modified", is_binary: false },
        { path: "notes.md", kind: "Added", is_binary: false },
        { path: "old.sk", kind: "Renamed", is_binary: false },
      ],
    });
    previewVersionFile.mockImplementation(async (version: string) => ({
      content: version === "a" ? sketch(["r1"]) : sketch(["r1", "r2"]),
      is_binary: false,
    }));
    const summary = await loadVersionChangeSummary("a", "b");
    expect(diffVersions).toHaveBeenCalledWith("a", "b");
    expect(previewVersionFile.mock.calls).toEqual([["a", "intro.sk"], ["b", "intro.sk"]]);
    expect(summary.totals.rowsAdded).toBe(1);
    expect(summary.totals.documentsAdded).toBe(1);
    expect(summary.totals.documentsRenamed).toBe(1);
  });

  it("caches successful loads and retries failed ones", async () => {
    diffVersions.mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ files: [] });
    await expect(loadVersionChangeSummary("a", "b")).rejects.toThrow("boom");
    await loadVersionChangeSummary("a", "b");
    await loadVersionChangeSummary("a", "b");
    expect(diffVersions).toHaveBeenCalledTimes(2);
  });
});

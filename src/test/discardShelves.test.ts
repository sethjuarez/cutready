import { beforeEach, describe, expect, it, vi } from "vitest";

const f = {
  changes: vi.fn(),
  selectedShelve: vi.fn(),
  shelves: vi.fn(),
  applyShelf: vi.fn(),
};
const deleteShelf = vi.fn();

vi.mock("../services/draftlineVersioning", () => ({
  facade: () => f,
  requireWorkspacePath: () => "C:/proj",
  draftlineClient: { deleteShelf: (...args: unknown[]) => deleteShelf(...args) },
}));

const { pruneDiscardShelves, shelveForDiscard, undoDiscardShelf } = await import("../services/discardShelves");
const { DISCARD_SHELF_MAX_AGE_MS, discardShelfName } = await import("../domain/versioning");

const shelf = (id: string) => ({ id, version: { id: "v", label: "", author: "", saved_by: "", time_seconds: 0 } });

beforeEach(() => {
  vi.clearAllMocks();
  f.selectedShelve.mockImplementation(async (_paths: string[], name: string) => ({ shelf: shelf(name) }));
});

describe("shelveForDiscard", () => {
  it("shelves the given paths under a unique discard shelf", async () => {
    const id = await shelveForDiscard(["intro.sk"], 1000);
    expect(f.selectedShelve).toHaveBeenCalledWith(["intro.sk"], expect.stringMatching(/^cutready-discard-1000-/));
    expect(id).toMatch(/^cutready-discard-1000-/);
  });

  it("shelves every change when no paths are given, and skips when clean", async () => {
    f.changes.mockResolvedValueOnce({ files: [{ path: "a.sk" }, { path: "b.md" }] });
    await shelveForDiscard();
    expect(f.selectedShelve).toHaveBeenCalledWith(["a.sk", "b.md"], expect.any(String));

    f.changes.mockResolvedValueOnce({ files: [] });
    expect(await shelveForDiscard()).toBeNull();
    expect(f.selectedShelve).toHaveBeenCalledTimes(1);
  });
});

describe("undoDiscardShelf", () => {
  it("applies and deletes the shelf", async () => {
    f.shelves.mockResolvedValue([shelf("s1")]);
    expect(await undoDiscardShelf("s1")).toBe("restored");
    expect(f.applyShelf).toHaveBeenCalledWith("s1");
    expect(deleteShelf).toHaveBeenCalledWith({ workspace_path: "C:/proj", shelf_id: "s1" });
  });

  it("keeps the shelf when Draftline refuses the apply", async () => {
    f.shelves.mockResolvedValue([shelf("s1")]);
    f.applyShelf.mockRejectedValueOnce({ code: "preflight_failed", message: "dirty" });
    expect(await undoDiscardShelf("s1")).toBe("conflict");
    expect(deleteShelf).not.toHaveBeenCalled();
  });

  it("rethrows other failures and reports missing shelves", async () => {
    f.shelves.mockResolvedValue([shelf("s1")]);
    f.applyShelf.mockRejectedValueOnce(new Error("boom"));
    await expect(undoDiscardShelf("s1")).rejects.toThrow("boom");
    expect(await undoDiscardShelf("gone")).toBe("missing");
  });

  it("still reports restored when only the shelf cleanup fails", async () => {
    f.shelves.mockResolvedValue([shelf("s1")]);
    deleteShelf.mockRejectedValueOnce(new Error("locked"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await undoDiscardShelf("s1")).toBe("restored");
    warn.mockRestore();
  });
});

describe("pruneDiscardShelves", () => {
  it("deletes only stale discard shelves", async () => {
    const now = 10 * DISCARD_SHELF_MAX_AGE_MS;
    const stale = discardShelfName(now - DISCARD_SHELF_MAX_AGE_MS - 1);
    f.shelves.mockResolvedValue([shelf(stale), shelf(discardShelfName(now)), shelf("cutready-stash")]);
    expect(await pruneDiscardShelves(now)).toBe(1);
    expect(deleteShelf).toHaveBeenCalledTimes(1);
    expect(deleteShelf).toHaveBeenCalledWith({ workspace_path: "C:/proj", shelf_id: stale });
  });
});

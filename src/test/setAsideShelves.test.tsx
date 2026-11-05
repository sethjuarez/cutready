import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = {
  changes: vi.fn(),
  selectedShelve: vi.fn(),
  shelves: vi.fn(),
  applyShelf: vi.fn(),
};

vi.mock("../services/draftlineVersioning", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/draftlineVersioning")>()),
  facade: () => f,
  requireWorkspacePath: () => "C:/proj",
  draftlineClient: { deleteShelf: vi.fn() },
}));

const {
  DEFAULT_SET_ASIDE_NAME,
  discardShelfName,
  discardShelvesToPrune,
  setAsideNameFor,
  setAsideShelfId,
  setAsideShelfName,
  setAsideShelves,
} = await import("../domain/versioning");
const { listSetAsideShelves, setAsideChanges } = await import("../services/setAsideShelves");
const { SetAsideBanner } = await import("../components/versioning/SetAsideBanner");
const { useVersioningStore } = await import("../stores/versioningStore");

const shelf = (id: string, seconds = 0) => ({ id, version: { time_seconds: seconds } });
/** Draftline's shelf-name rules (validate_variation_name) plus git's ref rules it relies on. */
const validRefName = (id: string) =>
  !/[\s~^:?*[\\]|\.\.|@\{|[\u0000-\u001f\u007f]/.test(id) && !id.endsWith(".") && !id.endsWith(".lock");

describe("set-aside shelf ids", () => {
  it("round-trips a readable name through a valid, unique ref name", () => {
    const name = "Before Draft 2: *final* (v1.0) ~ä";
    const id = setAsideShelfId(name, 1_700_000_000_000, () => 0.5);
    expect(id.startsWith("cutready-setaside-1700000000000-")).toBe(true);
    expect(validRefName(id)).toBe(true);
    expect(setAsideShelfName(id)).toBe(name);
    expect(setAsideShelfId(name, 1, () => 0.1)).not.toBe(setAsideShelfId(name, 1, () => 0.2));
  });

  it("caps very long names so the ref path stays short", () => {
    const id = setAsideShelfId("é".repeat(200), 1, () => 0);
    expect(id.length).toBeLessThan(130);
    expect(setAsideShelfName(id)).toMatch(/^é+$/);
  });

  it("names shelves after the action and falls back for empty or legacy ones", () => {
    expect(setAsideNameFor("switching to alt")).toBe("Before switching to alt");
    expect(setAsideNameFor("  ")).toBe(DEFAULT_SET_ASIDE_NAME);
    expect(setAsideShelfName(setAsideShelfId("", 1))).toBe(DEFAULT_SET_ASIDE_NAME);
    expect(setAsideShelfName("cutready-stash")).toBe(DEFAULT_SET_ASIDE_NAME);
    expect(setAsideShelfName("cutready-setaside-1-abc-%E0%A4")).toBe(DEFAULT_SET_ASIDE_NAME);
    expect(setAsideShelfName(discardShelfName(1))).toBeNull();
  });

  it("lists only set-aside shelves, newest first, and never prunes them", () => {
    const older = setAsideShelfId("Older", 1);
    const newer = setAsideShelfId("Newer", 2);
    const listed = setAsideShelves([shelf(older, 10), shelf(discardShelfName(5), 50), shelf("cutready-stash", 5), shelf(newer, 20)]);
    expect(listed).toEqual([
      { id: newer, name: "Newer", timeMs: 20_000 },
      { id: older, name: "Older", timeMs: 10_000 },
      { id: "cutready-stash", name: DEFAULT_SET_ASIDE_NAME, timeMs: 5_000 },
    ]);
    expect(discardShelvesToPrune([older, newer, "cutready-stash"], Number.MAX_SAFE_INTEGER)).toEqual([]);
  });
});

describe("setAsideChanges", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sets every change aside in a new named shelf, even when others exist", async () => {
    f.changes.mockResolvedValue({ files: [{ path: "a.sk" }, { path: "b.md" }] });
    f.shelves.mockResolvedValue([shelf(setAsideShelfId("First", 1), 1)]);
    expect(await setAsideChanges("Second", 2000)).toBe(true);
    expect(f.selectedShelve).toHaveBeenCalledWith(["a.sk", "b.md"], expect.stringMatching(/^cutready-setaside-2000-[0-9a-z]+-Second$/));
    expect(await listSetAsideShelves()).toHaveLength(1);
  });

  it("does nothing when there's nothing to set aside", async () => {
    f.changes.mockResolvedValue({ files: [] });
    expect(await setAsideChanges("x")).toBe(false);
    expect(f.selectedShelve).not.toHaveBeenCalled();
  });
});

describe("SetAsideBanner", () => {
  const original = useVersioningStore.getState();
  const now = new Date(1_700_000_600_000);
  const a = { id: "cutready-setaside-1-a-A", name: "Before switching to alt", timeMs: 1_700_000_000_000 };
  const b = { id: "cutready-setaside-2-b-B", name: "Before getting updates", timeMs: 1_700_000_300_000 };
  let popStash: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
  let dropStash: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;

  beforeEach(() => {
    popStash = vi.fn<(id: string) => Promise<void>>(() => Promise.resolve());
    dropStash = vi.fn<(id: string) => Promise<void>>(() => Promise.resolve());
    useVersioningStore.setState({ popStash, dropStash });
  });
  afterEach(() => {
    cleanup();
    act(() => useVersioningStore.setState(original, true));
  });

  it("shows one shelf inline with its name and time", () => {
    act(() => useVersioningStore.setState({ setAsideShelves: [a] }));
    render(<SetAsideBanner disabled={false} now={now} />);
    expect(screen.getByTestId("project-health-shelf")).toHaveTextContent("Before switching to alt · 10m ago");
    fireEvent.click(screen.getByRole("button", { name: "Restore Before switching to alt" }));
    expect(popStash).toHaveBeenCalledWith(a.id);
  });

  it("lists several shelves and deletes one only after confirming", () => {
    act(() => useVersioningStore.setState({ setAsideShelves: [b, a] }));
    render(<SetAsideBanner disabled={false} now={now} />);
    expect(screen.getByText("2 sets of changes are set aside.")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Show" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("list", { name: "Set-aside changes" }).children).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Delete Before getting updates" }));
    expect(dropStash).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete Before getting updates for good" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Keep Before getting updates" }));
    expect(screen.getByRole("button", { name: "Delete Before getting updates" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Delete Before getting updates" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Before getting updates for good" }));
    expect(dropStash).toHaveBeenCalledWith(b.id);
  });

  it("renders nothing without shelves", () => {
    const { container } = render(<SetAsideBanner disabled={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("disables every shelf action while one is running", () => {
    act(() => useVersioningStore.setState({ setAsideShelves: [a], setAsideBusy: true }));
    render(<SetAsideBanner disabled={false} now={now} />);
    expect(screen.getByRole("button", { name: "Restore Before switching to alt" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Before switching to alt" })).toBeDisabled();
  });
});

describe("popStash", () => {
  const original = useVersioningStore.getState();
  afterEach(() => act(() => useVersioningStore.setState(original, true)));

  it("refuses over unsaved work before touching editors or the shelf", async () => {
    const checkDirty = vi.fn(async () => useVersioningStore.setState({ isDirty: true }));
    useVersioningStore.setState({ checkDirty });
    f.shelves.mockClear();
    f.applyShelf.mockClear();
    await useVersioningStore.getState().popStash("cutready-setaside-1-a-A");
    expect(checkDirty).toHaveBeenCalled();
    expect(f.shelves).not.toHaveBeenCalled();
    expect(f.applyShelf).not.toHaveBeenCalled();
    expect(useVersioningStore.getState().setAsideBusy).toBe(false);
  });
});

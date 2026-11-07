import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/tauri", () => ({
  invoke: vi.fn(async () => null),
  listen: vi.fn(),
  once: vi.fn(),
  emit: vi.fn(),
  emitTo: vi.fn(),
  convertFileSrc: vi.fn((path: string) => path),
  Channel: class {},
}));
vi.mock("../components/ProjectImage", () => ({ ProjectImage: () => <img alt="" /> }));
vi.mock("../components/VisualCell", () => ({ default: () => <div /> }));

import { MediaView } from "../components/media/MediaView";
import { useAppStore, type AssetInfo, type NarrationAssetInfo } from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";

const assets: AssetInfo[] = [
  { path: ".cutready/screenshots/used.png", size: 10, referencedBy: ["sketches/a.sk"], assetType: "screenshot", modifiedAt: 2 },
  { path: ".cutready/screenshots/orphan.png", size: 10, referencedBy: [], assetType: "screenshot", modifiedAt: 1 },
];
const narrationAssets: NarrationAssetInfo[] = [
  { path: ".cutready/narration/old.webm", size: 10, mimeType: "audio/webm", referencedBy: [], modifiedAt: 0 },
];

const original = useAppStore.getState();
const loadAssets = vi.fn(async () => undefined);
const loadNarrationAssets = vi.fn(async () => undefined);
const deleteUnlinkedAssets = vi.fn(async (paths: string[]) => paths.length);
const deleteUnlinkedNarrationAssets = vi.fn(async (paths: string[]) => paths.length);
const project = (root: string) => ({ root, name: root }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  act(() => useAppStore.setState({
    currentProject: project("/a"),
    assets,
    narrationAssets,
    sketches: [{ path: "sketches/a.sk", title: "Intro" } as never],
    loadAssets,
    loadNarrationAssets,
    deleteUnlinkedAssets,
    deleteUnlinkedNarrationAssets,
  }));
});

afterEach(() => {
  cleanup();
  act(() => useAppStore.setState(original, true));
  useToastStore.setState({ toasts: [] } as never);
});

describe("MediaView", () => {
  it("shows usage and an Unused badge", () => {
    render(<MediaView />);
    expect(screen.getAllByTestId("media-card")).toHaveLength(3);
    expect(screen.getByTestId("media-filter-unused")).toHaveTextContent("2");
    expect(screen.getAllByTestId("media-unused-badge")).toHaveLength(2);

    fireEvent.click(screen.getByTestId("media-usage"));
    expect(screen.getByRole("list", { name: "Documents using used.png" })).toHaveTextContent("Intro");
  });

  it("offers Remove unused only under the Unused filter", () => {
    render(<MediaView />);
    expect(screen.queryByTestId("media-remove-unused")).toBeNull();
    fireEvent.click(screen.getByTestId("media-filter-unused"));
    expect(screen.getByTestId("media-filter-unused")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("media-remove-unused")).toHaveTextContent("Remove unused (2)");
  });

  it("confirms with the file list, then deletes exactly those files", async () => {
    render(<MediaView />);
    fireEvent.click(screen.getByTestId("media-filter-unused"));
    fireEvent.click(screen.getByTestId("media-remove-unused"));

    const dialog = await screen.findByTestId("media-remove-dialog");
    expect(loadAssets).toHaveBeenCalled();
    const list = await within(dialog).findByRole("list", { name: "Files to remove" });
    expect(list).toHaveTextContent("orphan.png");
    expect(list).toHaveTextContent("old.webm");
    expect(list).not.toHaveTextContent("used.png");
    expect(dialog).toHaveTextContent(/restoring an earlier version/);

    fireEvent.click(within(dialog).getByTestId("media-remove-confirm"));
    await waitFor(() => expect(screen.queryByTestId("media-remove-dialog")).toBeNull());
    expect(deleteUnlinkedAssets).toHaveBeenCalledWith([".cutready/screenshots/orphan.png"]);
    expect(deleteUnlinkedNarrationAssets).toHaveBeenCalledWith([".cutready/narration/old.webm"]);
  });

  it("deletes nothing when the confirm is cancelled", async () => {
    render(<MediaView />);
    fireEvent.click(screen.getByTestId("media-filter-unused"));
    fireEvent.click(screen.getByTestId("media-remove-unused"));
    fireEvent.click(within(await screen.findByTestId("media-remove-dialog")).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByTestId("media-remove-dialog")).toBeNull();
    expect(deleteUnlinkedAssets).not.toHaveBeenCalled();
    expect(deleteUnlinkedNarrationAssets).not.toHaveBeenCalled();
  });

  it("searches by name and shows an empty state for Video", () => {
    render(<MediaView />);
    fireEvent.change(screen.getByTestId("media-search"), { target: { value: "orph" } });
    expect(screen.getAllByTestId("media-card")).toHaveLength(1);
    fireEvent.change(screen.getByTestId("media-search"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("media-filter-video"));
    expect(screen.getByTestId("media-empty")).toHaveTextContent("No video yet.");
  });

  it("drops a confirm planned in another project", async () => {
    render(<MediaView />);
    fireEvent.click(screen.getByTestId("media-filter-unused"));
    fireEvent.click(screen.getByTestId("media-remove-unused"));
    const confirm = within(await screen.findByTestId("media-remove-dialog")).getByTestId("media-remove-confirm");

    act(() => useAppStore.setState({ currentProject: project("/b") }));
    fireEvent.click(confirm);

    await waitFor(() => expect(screen.queryByTestId("media-remove-dialog")).toBeNull());
    expect(deleteUnlinkedAssets).not.toHaveBeenCalled();
    expect(deleteUnlinkedNarrationAssets).not.toHaveBeenCalled();
  });

  it("reports a failed removal and reloads the library", async () => {
    deleteUnlinkedNarrationAssets.mockRejectedValueOnce(new Error("disk busy"));
    render(<MediaView />);
    fireEvent.click(screen.getByTestId("media-filter-unused"));
    fireEvent.click(screen.getByTestId("media-remove-unused"));
    const dialog = await screen.findByTestId("media-remove-dialog");
    expect(dialog.closest("[role=alertdialog]")).not.toBeNull();
    loadAssets.mockClear();

    fireEvent.click(within(dialog).getByTestId("media-remove-confirm"));

    await waitFor(() => expect(screen.queryByTestId("media-remove-dialog")).toBeNull());
    expect(useToastStore.getState().toasts.map((t) => t.message).join("\n")).toMatch(/disk busy/);
    expect(loadAssets).toHaveBeenCalled();
  });
});

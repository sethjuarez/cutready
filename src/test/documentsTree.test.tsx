import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/tauri", () => ({
  invoke: vi.fn(async () => []),
  listen: vi.fn(async () => () => undefined),
  once: vi.fn(),
  emit: vi.fn(),
  emitTo: vi.fn(),
  convertFileSrc: vi.fn((path: string) => path),
  Channel: class {},
}));
vi.mock("../hooks/useSettings", () => ({
  useSettings: () => ({ settings: {}, updateSetting: vi.fn(), loaded: false }),
}));
vi.mock("../hooks/useStoryboardMembership", () => ({
  useStoryboardMembership: () => new Map([["tour.sb", ["intro.sk", "checkout.sk"]]]),
}));

import { StoryboardList } from "../components/StoryboardList";
import { useAppStore } from "../stores/appStore";
import type { NoteSummary, SketchSummary, StoryboardSummary } from "../types/sketch";

const initial = useAppStore.getState();
const sketch = (path: string, title: string) => ({ path, title }) as unknown as SketchSummary;

describe("Documents tree", () => {
  const openSketch = vi.fn(async () => undefined);

  beforeEach(() => {
    const noop = vi.fn(async () => undefined);
    act(() =>
      useAppStore.setState({
        storyboards: [{ path: "tour.sb", title: "Tour" } as unknown as StoryboardSummary],
        sketches: [sketch("intro.sk", "Aurora Onboarding"), sketch("checkout.sk", "Falcon Checkout"), sketch("loose.sk", "Loose Ends")],
        notes: [{ path: "brief.md", title: "brief" } as unknown as NoteSummary],
        chatArtifacts: [],
        sidebarOrder: null,
        openTabs: [{ id: "t1", type: "sketch", path: "checkout.sk", title: "Falcon Checkout" }] as never,
        activeTabId: "t1",
        activeStoryboardPath: null,
        loadStoryboards: noop,
        loadSketches: noop,
        loadNotes: noop,
        loadChatArtifacts: noop,
        openSketch,
        closeStoryboard: vi.fn(),
      }),
    );
  });

  afterEach(() => {
    cleanup();
    act(() => useAppStore.setState(initial, true));
    openSketch.mockClear();
  });

  it("lists every sketch under Sketches, including ones in storyboards", () => {
    render(<StoryboardList />);
    for (const path of ["intro.sk", "checkout.sk", "loose.sk"]) {
      expect(screen.getByTestId(`explorer-item-${path}`)).toHaveAttribute("title");
    }
    expect(screen.getByTestId("explorer-item-loose.sk")).toHaveTextContent("Loose Ends");
    expect(screen.getAllByRole("button", { name: "Rename Falcon Checkout" })).toHaveLength(1);
  });

  it("keeps the sidebar flat: no nested sketch rows under storyboards", () => {
    render(<StoryboardList />);
    expect(screen.getAllByTitle("Falcon Checkout")).toEqual([screen.getByTestId("explorer-item-checkout.sk")]);
    expect(screen.getByTestId("explorer-item-tour.sb")).not.toHaveAttribute("aria-expanded");
  });

  it("highlights exactly one row, the active document", () => {
    render(<StoryboardList />);
    const current = screen.getAllByRole("button").filter((row) => row.getAttribute("aria-current") === "page");
    expect(current).toEqual([screen.getByTestId("explorer-item-checkout.sk")]);
  });

  it("opens a sketch from the Sketches section", () => {
    render(<StoryboardList />);
    fireEvent.click(screen.getByTestId("explorer-item-intro.sk"));
    expect(openSketch).toHaveBeenCalledWith("intro.sk");
  });

  it("collapses a section and reopens it from its + button", () => {
    render(<StoryboardList />);
    const header = screen.getByRole("button", { name: "Notes" });
    const body = () => screen.getByTestId("explorer-item-brief.md").closest(".cr-sec-body")!;
    expect(header).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(body()).toHaveAttribute("data-open", "false");
    expect(body()).toHaveAttribute("inert");

    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(body()).not.toHaveAttribute("inert");
    expect(screen.getByLabelText("Note name")).toBeInTheDocument();
  });

  it("keeps row actions outside the row control", () => {
    render(<StoryboardList />);
    const row = screen.getByTestId("explorer-item-loose.sk");
    const rename = screen.getByRole("button", { name: "Rename Loose Ends" });
    expect(row).not.toContainElement(rename);
    expect(row.parentElement).toContainElement(rename);
    expect(row).not.toHaveAttribute("aria-roledescription");
  });
});

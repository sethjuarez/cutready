import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/tauri", () => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  once: vi.fn(),
  emit: vi.fn(),
  emitTo: vi.fn(),
  convertFileSrc: vi.fn((path: string) => path),
  Channel: class {},
}));
vi.mock("../components/UpdateAvailableButton", () => ({ UpdateAvailableButton: () => null }));

import { Sidebar } from "../components/Sidebar";
import { useAppStore } from "../stores/appStore";
import { useVersioningStore } from "../stores/versioningStore";
import type { DiffEntry } from "../types/sketch";
import { panelOwner } from "../utils/navigation";

const originalSetView = useAppStore.getState().setView;
const project = { root: "/p", name: "p" } as unknown as ReturnType<typeof useAppStore.getState>["currentProject"];
const changed = (path: string) => ({ path, status: "modified" }) as unknown as DiffEntry;

afterEach(() => {
  cleanup();
  act(() => {
    useAppStore.setState({ currentProject: null, view: "home", setView: originalSetView });
    useVersioningStore.setState({ changedFiles: [] });
  });
});

describe("panelOwner", () => {
  it("maps views to the row that owns their panel", () => {
    expect(panelOwner("assets")).toBe("assets");
    expect(panelOwner("changes")).toBe("changes");
    expect(panelOwner("project")).toBe("project");
    expect(panelOwner("recording")).toBe("project");
    expect(panelOwner("chat")).toBeNull();
    expect(panelOwner("settings")).toBeNull();
  });
});

describe("Sidebar", () => {
  it("renders labelled rows with the active panel nested under its row", () => {
    act(() => useAppStore.setState({ currentProject: project, view: "changes" }));
    render(<Sidebar expanded panel={<div data-testid="panel-body" />} onToggleExpanded={() => {}} />);

    const changes = screen.getByTestId("activity-changes");
    expect(changes).toHaveTextContent("Changes");
    expect(changes).toHaveAttribute("aria-current", "page");
    expect(changes).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("activity-project")).toHaveAttribute("aria-expanded", "false");
    expect(changes.parentElement).toContainElement(screen.getByTestId("panel-body"));
    expect(screen.getByTestId("nav-toggle")).toHaveAttribute("aria-expanded", "true");
  });

  it("shows the panel for the background view while Settings is open", () => {
    act(() => useAppStore.setState({ currentProject: project, view: "settings" }));
    render(<Sidebar expanded panelView="assets" panel={<div data-testid="panel-body" />} />);

    expect(screen.getByTestId("activity-assets").parentElement).toContainElement(screen.getByTestId("panel-body"));
    expect(screen.getByTestId("activity-settings")).toHaveAttribute("aria-current", "page");
  });

  it("collapses to an icon rail without labels or panel", () => {
    act(() => useAppStore.setState({ currentProject: project, view: "project" }));
    render(<Sidebar panel={<div data-testid="panel-body" />} />);

    expect(screen.getByTestId("app-nav")).toHaveAttribute("data-expanded", "false");
    expect(screen.getByTestId("activity-project")).toHaveAccessibleName("Documents");
    expect(screen.getByTestId("activity-project")).not.toHaveTextContent("Documents");
    expect(screen.queryByTestId("panel-body")).toBeNull();
  });

  it("badges unsaved changes and disables project rows without a project", () => {
    act(() => useVersioningStore.setState({ changedFiles: [changed("a.sk"), changed("b.md")] }));
    const setView = vi.fn();
    act(() => useAppStore.setState({ view: "project", setView }));
    const onChatToggle = vi.fn();
    render(<Sidebar expanded onChatToggle={onChatToggle} />);

    const changes = screen.getByTestId("activity-changes");
    expect(changes).toHaveTextContent("2");
    expect(changes).toBeDisabled();
    fireEvent.click(changes);
    expect(setView).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("activity-chat"));
    expect(onChatToggle).toHaveBeenCalledTimes(1);
  });
});

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
vi.mock("../components/UpdateAvailableButton", () => ({ UpdateAvailableButton: () => null }));

import { initials, Sidebar } from "../components/Sidebar";
import { invoke } from "../services/tauri";
import { TreeRow } from "../components/docTree/TreeRow";
import { useExitChatFocusOnNavigate } from "../hooks/useExitChatFocusOnNavigate";
import { useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";
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
    useChatStore.setState({ chatFocusMode: false });
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
    render(<Sidebar panel={<div data-testid="panel-body" />} documents={<div data-testid="docs" />} />);

    const changes = screen.getByTestId("activity-changes");
    expect(changes).toHaveTextContent("Changes");
    expect(changes).toHaveAttribute("aria-current", "page");
    expect(changes).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("activity-assets")).toHaveAttribute("aria-expanded", "false");
    expect(changes.parentElement).toContainElement(screen.getByTestId("panel-body"));
    expect(screen.getByTestId("docs")).toBeInTheDocument();
  });

  it("shows the panel for the background view while Settings is open", () => {
    act(() => useAppStore.setState({ currentProject: project, view: "settings" }));
    render(<Sidebar panelView="assets" panel={<div data-testid="panel-body" />} />);

    expect(screen.getByTestId("activity-assets").parentElement).toContainElement(screen.getByTestId("panel-body"));
    expect(screen.getByTestId("activity-settings")).toHaveAttribute("aria-current", "page");
  });

  it("collapses to a zero-width, inert track without the panel", () => {
    act(() => useAppStore.setState({ currentProject: project, view: "assets" }));
    render(<Sidebar expanded={false} width={300} panel={<div data-testid="panel-body" />} />);

    const nav = screen.getByTestId("app-nav");
    expect(nav).toHaveAttribute("data-expanded", "false");
    expect(nav).toHaveAttribute("inert");
    expect(nav.style.width).toBe("0px");
    expect(screen.queryByTestId("panel-body")).toBeNull();
  });

  it("shows a count chip for unsaved changes and disables project rows without a project", () => {
    act(() => useVersioningStore.setState({ changedFiles: [changed("a.sk"), changed("b.md")] }));
    const setView = vi.fn();
    act(() => useAppStore.setState({ view: "project", setView }));
    const onChatToggle = vi.fn();
    render(<Sidebar onChatToggle={onChatToggle} />);

    const changes = screen.getByTestId("activity-changes");
    expect(changes.querySelector(".count")).toHaveTextContent("2");
    expect(changes).toBeDisabled();
    fireEvent.click(changes);
    expect(setView).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("activity-chat"));
    expect(onChatToggle).toHaveBeenCalledTimes(1);
  });
});

describe("Sidebar identity footer", () => {
  const identity = (name: string, needs_setup = false) => ({
    name,
    email: needs_setup ? null : "seth@example.com",
    name_source: needs_setup ? "system" : "profile",
    email_source: needs_setup ? null : "profile",
    profile: needs_setup ? null : { name, email: "seth@example.com" },
    needs_setup,
  });

  it("shows the contributor's initials and name, opening Profile settings on click", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(identity("Seth Juarez"));
    act(() => useChatStore.setState({ chatFocusMode: true }));
    const onProfile = vi.fn();
    render(<Sidebar onProfile={onProfile} onFeedback={vi.fn()} />);

    const me = await screen.findByRole("button", { name: "Profile: Seth Juarez" });
    expect(me).toHaveTextContent("SJ");
    expect(me).toHaveTextContent("Seth Juarez");
    expect(invoke).toHaveBeenCalledWith("get_contributor_identity");
    fireEvent.click(me);
    expect(onProfile).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().chatFocusMode).toBe(false);
    expect(screen.getByTestId("activity-feedback")).toHaveAccessibleName("Send feedback");
    expect(screen.getByTestId("activity-settings")).toHaveAccessibleName("Settings");
  });

  it("prompts to set up an identity when none is configured", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(identity("demo-user", true));
    render(<Sidebar />);
    const me = screen.getByTestId("nav-identity");
    expect(me).toHaveTextContent("Set up identity");
    await act(async () => undefined);
    expect(me).toHaveTextContent("Set up identity");
    expect(me).toHaveClass("setup");
  });

  it("reloads the identity when the open repository changes", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(identity("demo-user", true)).mockResolvedValueOnce(identity("Repo Author"));
    render(<Sidebar />);
    await act(async () => undefined);
    expect(screen.getByTestId("nav-identity")).toHaveTextContent("Set up identity");

    act(() => useAppStore.setState({ currentProject: { ...project!, repo_root: "/repo" } }));
    expect(await screen.findByRole("button", { name: "Profile: Repo Author" })).toBeInTheDocument();
  });

  it("derives up to two initials", () => {
    expect(initials("Seth Juarez")).toBe("SJ");
    expect(initials("ada.lovelace")).toBe("AL");
    expect(initials("cher")).toBe("CH");
    expect(initials(" ")).toBe("?");
  });
});

describe("navigating while chat focus is on", () => {
  it("exits focus when a nav row is clicked, even for the current view", () => {
    act(() => {
      useAppStore.setState({ currentProject: project, view: "home" });
      useChatStore.setState({ chatFocusMode: true });
    });
    render(<Sidebar />);

    fireEvent.click(screen.getByTestId("activity-home"));
    expect(useChatStore.getState().chatFocusMode).toBe(false);

    act(() => useChatStore.setState({ chatFocusMode: true }));
    fireEvent.click(screen.getByTestId("activity-changes"));
    expect(useChatStore.getState().chatFocusMode).toBe(false);
    expect(useAppStore.getState().view).toBe("changes");
  });

  it("exits focus when a document is opened from the tree", () => {
    act(() => useChatStore.setState({ chatFocusMode: true }));
    const onOpen = vi.fn();
    render(<TreeRow depth="note" label="brief" icon="note" kind="note" selected={false} onOpen={onOpen} testId="row" />);

    fireEvent.click(screen.getByTestId("row"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().chatFocusMode).toBe(false);
  });

  it("exits focus when the view changes from anywhere", () => {
    act(() => useAppStore.setState({ currentProject: project, view: "project" }));
    renderHook(() => useExitChatFocusOnNavigate());
    act(() => useChatStore.setState({ chatFocusMode: true }));
    expect(useChatStore.getState().chatFocusMode).toBe(true);

    act(() => useAppStore.setState({ view: "home" }));
    expect(useChatStore.getState().chatFocusMode).toBe(false);
  });
});

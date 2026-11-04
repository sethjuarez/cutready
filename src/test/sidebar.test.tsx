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
import { panelOwner, sketchUsage, usageLabel } from "../utils/navigation";

const originalSetView = useAppStore.getState().setView;
const project = { root: "/p", name: "p" } as unknown as ReturnType<typeof useAppStore.getState>["currentProject"];

afterEach(() => {
  cleanup();
  act(() => {
    useAppStore.setState({ currentProject: null, view: "home", setView: originalSetView, assets: [], narrationAssets: [] });
    useVersioningStore.setState({ changedFiles: [] });
    useChatStore.setState({ chatFocusMode: false });
  });
});

describe("panelOwner", () => {
  it("maps views to the row that owns them", () => {
    expect(panelOwner("assets")).toBe("media");
    expect(panelOwner("narrations")).toBe("media");
    expect(panelOwner("changes")).toBe("changes");
    expect(panelOwner("project")).toBe("project");
    expect(panelOwner("recording")).toBe("project");
    expect(panelOwner("chat")).toBeNull();
    expect(panelOwner("settings")).toBeNull();
  });
});

describe("sketch usage", () => {
  it("counts each storyboard once per sketch", () => {
    const usage = sketchUsage(new Map([
      ["a.sb", ["s.sk", "t.sk", "s.sk"]],
      ["b.sb", ["s.sk"]],
      ["c.sb", []],
    ]));
    expect(usage.get("s.sk")).toBe(2);
    expect(usage.get("t.sk")).toBe(1);
    expect(usage.has("u.sk")).toBe(false);
  });

  it("labels used sketches only", () => {
    expect(usageLabel(0)).toBeUndefined();
    expect(usageLabel(1)).toBe("in 1 storyboard");
    expect(usageLabel(3)).toBe("in 3 storyboards");
  });
});

describe("Sidebar", () => {
  const asset = (path: string, referencedBy: string[]) => ({ path, size: 1, referencedBy, assetType: "screenshot" as const, modifiedAt: 0 });

  it("puts Home first, the documents next, then a Library group with Media", () => {
    act(() => useAppStore.setState({ currentProject: project, view: "assets" }));
    render(<Sidebar documents={<div data-testid="docs" />} />);

    const media = screen.getByTestId("activity-media");
    expect(media).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("nav-library")).toContainElement(media);
    expect(screen.getByTestId("docs").compareDocumentPosition(media) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("activity-assets")).toBeNull();
    expect(screen.queryByTestId("activity-narrations")).toBeNull();
    expect(screen.queryByTestId("activity-changes")).toBeNull();
    expect(screen.queryByTestId("activity-chat")).toBeNull();
  });

  it("selects Media for the legacy Narrations view too", () => {
    act(() => useAppStore.setState({ currentProject: project, view: "narrations" }));
    render(<Sidebar />);
    expect(screen.getByTestId("activity-media")).toHaveAttribute("aria-current", "page");
  });

  it("shows a count of unused media only when there is some", async () => {
    act(() => useAppStore.setState({ currentProject: project, view: "project" }));
    render(<Sidebar />);
    await act(async () => undefined);
    act(() => useAppStore.setState({
      assets: [asset("a.png", ["s.sk"]), asset("b.png", []), asset("c.png", [])],
      narrationAssets: [],
    }));
    expect(screen.getByTestId("media-unused-count")).toHaveTextContent("2");

    act(() => useAppStore.setState({ assets: [asset("a.png", ["s.sk"])] }));
    expect(screen.queryByTestId("media-unused-count")).toBeNull();
  });

  it("shows the Changes list as a closable section in the Changes view", () => {
    const setView = vi.fn();
    act(() => useAppStore.setState({ currentProject: project, view: "changes", setView }));
    render(<Sidebar panel={<div data-testid="panel-body" />} />);

    const section = screen.getByTestId("nav-changes");
    expect(section).toContainElement(screen.getByTestId("panel-body"));
    fireEvent.click(screen.getByRole("button", { name: "Close changes" }));
    expect(setView).toHaveBeenCalledWith("project");
  });

  it("keeps the background view's selection while Settings is open", () => {
    act(() => useAppStore.setState({ currentProject: project, view: "settings" }));
    render(<Sidebar panelView="assets" />);

    expect(screen.getByTestId("activity-media")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("activity-settings")).toHaveAttribute("aria-current", "page");
  });

  it("collapses to a zero-width, inert track without the panel", () => {
    act(() => useAppStore.setState({ currentProject: project, view: "changes" }));
    render(<Sidebar expanded={false} width={300} panel={<div data-testid="panel-body" />} />);

    const nav = screen.getByTestId("app-nav");
    expect(nav).toHaveAttribute("data-expanded", "false");
    expect(nav).toHaveAttribute("inert");
    expect(nav.style.width).toBe("0px");
    expect(screen.queryByTestId("panel-body")).toBeNull();
  });

  it("hides the Library without a project", () => {
    act(() => useAppStore.setState({ view: "home" }));
    render(<Sidebar />);
    expect(screen.queryByTestId("activity-media")).toBeNull();
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
    let author = identity("demo-user", true);
    vi.mocked(invoke).mockImplementation(async (command: string) => (command === "get_contributor_identity" ? author : null) as never);
    render(<Sidebar />);
    await act(async () => undefined);
    expect(screen.getByTestId("nav-identity")).toHaveTextContent("Set up identity");

    author = identity("Repo Author");
    act(() => useAppStore.setState({ currentProject: { ...project!, repo_root: "/repo" } }));
    expect(await screen.findByRole("button", { name: "Profile: Repo Author" })).toBeInTheDocument();
    vi.mocked(invoke).mockImplementation(async () => null as never);
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
    fireEvent.click(screen.getByTestId("activity-media"));
    expect(useChatStore.getState().chatFocusMode).toBe(false);
    expect(useAppStore.getState().view).toBe("assets");
  });

  it("exits focus when a document is opened from the tree", () => {
    act(() => useChatStore.setState({ chatFocusMode: true }));
    const onOpen = vi.fn();
    render(<TreeRow label="brief" icon="note" kind="note" selected={false} onOpen={onOpen} testId="row" />);

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

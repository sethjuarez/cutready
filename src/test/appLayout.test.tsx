import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ isMac: false }));

vi.mock("../components/TitleBar", () => ({
  TitleBar: ({ onToggleChat }: { onToggleChat?: () => void }) => (
    <div data-testid="titlebar">
      <button type="button" data-testid="activity-chat" onClick={onToggleChat}>
        Chat
      </button>
    </div>
  ),
}));
vi.mock("../components/HomePanel", () => ({
  HomePanel: () => <div />,
}));
vi.mock("../components/RecordingPanel", () => ({
  RecordingPanel: () => <div />,
}));
vi.mock("../components/SettingsPanel", () => ({
  SettingsPanel: () => <div />,
}));
vi.mock("../components/Sidebar", () => ({
  Sidebar: () => <nav />,
}));
vi.mock("../components/StoryboardPanel", () => ({
  StoryboardPanel: () => <div />,
}));
vi.mock("../components/StoryboardList", () => ({
  StoryboardList: () => <div />,
}));
vi.mock("../components/OutputPanel", () => ({
  OutputPanel: () => <div data-testid="output-panel" />,
}));
vi.mock("../components/CommandPalette", () => ({
  CommandPalette: () => null,
}));
vi.mock("../components/SnapshotDialog", () => ({
  SnapshotDialog: () => null,
}));
vi.mock("../components/KeyboardShortcutsDialog", () => ({
  KeyboardShortcutsDialog: () => null,
}));
vi.mock("../components/MergeConflictPanel", () => ({
  MergeConflictPanel: () => <div />,
}));
vi.mock("../components/ChatPanel", () => ({
  ChatPanel: () => <div />,
}));
vi.mock("../components/FeedbackDialog", () => ({
  FeedbackDialog: () => null,
}));
vi.mock("../services/commandRegistry", () => ({
  commandRegistry: {
    execute: vi.fn(),
    register: vi.fn(() => () => undefined),
    registerMany: vi.fn(() => () => undefined),
  },
  useCommands: () => [],
}));
vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ theme: "light", toggle: vi.fn() }),
}));
vi.mock("../hooks/useSettings", () => ({
  useSettings: () => ({
    loaded: true,
    settings: {
      displayThemePalette: "default",
      displayFontSize: 13,
      displayChatFontSize: 13,
      displayRowDensity: "comfortable",
      displayRowColors: "default",
      displayEditorWidth: "standard",
      displayFontFamily: "system",
      featureRecording: false,
    },
  }),
}));
vi.mock("../utils/platform", () => ({
  get isMac() {
    return platform.isMac;
  },
}));

import { AppLayout } from "../components/AppLayout";
import { useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";
import { useVersioningStore } from "../stores/versioningStore";

describe("AppLayout titlebar spacing", () => {
  afterEach(() => {
    act(() => useChatStore.setState({ chatFocusMode: false }));
    act(() =>
      useAppStore.setState({
        currentProject: null,
        view: "home",
        outputVisible: true,
        showSecondaryPanel: false,
      }),
    );
    platform.isMac = false;
  });

  it("reserves fixed titlebar height for main content on Windows and Linux", () => {
    act(() => useChatStore.setState({ chatFocusMode: false }));
    act(() =>
      useAppStore.setState({
        view: "project",
      }),
    );

    render(<AppLayout />);

    expect(screen.getByTestId("app-content-shell")).toHaveStyle({
      paddingTop: "var(--titlebar-height)",
      paddingBottom: "var(--statusbar-height)",
    });
  });

  it("does not add duplicate titlebar spacing on macOS", () => {
    platform.isMac = true;
    act(() => useChatStore.setState({ chatFocusMode: false }));
    act(() =>
      useAppStore.setState({
        view: "project",
      }),
    );

    render(<AppLayout />);

    const shell = screen.getByTestId("app-content-shell");
    expect(shell.style.paddingTop).toBe("");
    expect(shell).toHaveStyle({
      paddingBottom: "var(--statusbar-height)",
    });
  });

  it("keeps chat focus mode below the fixed titlebar on Windows and Linux", () => {
    act(() => useChatStore.setState({ chatFocusMode: true }));
    act(() =>
      useAppStore.setState({
        view: "project",
      }),
    );

    render(<AppLayout />);

    expect(screen.getByTestId("chat-focus-shell")).toHaveStyle({
      top: "var(--titlebar-height)",
      bottom: "var(--statusbar-height)",
    });
  });

  it("starts chat focus mode at the navigation pane edge", () => {
    act(() => useChatStore.setState({ chatFocusMode: true }));
    act(() => useAppStore.setState({ view: "project", sidebarVisible: true, sidebarWidth: 260 }));
    const { unmount } = render(<AppLayout />);
    expect(screen.getByTestId("chat-focus-shell")).toHaveStyle({ left: "260px" });
    unmount();

    act(() => useAppStore.setState({ sidebarVisible: false }));
    render(<AppLayout />);
    expect(screen.getByTestId("chat-focus-shell")).toHaveStyle({ left: "0px" });
  });

  it("keeps chat focus mode below the native traffic light toolbar on macOS", () => {
    platform.isMac = true;
    act(() => useChatStore.setState({ chatFocusMode: true }));
    act(() =>
      useAppStore.setState({
        view: "project",
      }),
    );

    render(<AppLayout />);

    expect(screen.getByTestId("chat-focus-shell")).toHaveStyle({
      top: "var(--titlebar-height)",
      bottom: "var(--statusbar-height)",
    });
  });

  it("keeps the output panel mounted when navigating to views that hide it", () => {
    act(() => useChatStore.setState({ chatFocusMode: false }));
    act(() =>
      useAppStore.setState({
        outputVisible: true,
        view: "project",
      }),
    );

    render(<AppLayout />);

    expect(screen.getByTestId("output-panel")).toBeInTheDocument();

    act(() =>
      useAppStore.setState({
        view: "chat",
      }),
    );

    expect(screen.getByTestId("output-panel")).toBeInTheDocument();
  });

  it("cycles chat nav through side, focus, side, then hidden", () => {
    act(() => useChatStore.setState({ chatFocusMode: false }));
    act(() =>
      useAppStore.setState({
        currentProject: {
          name: "Demo",
          root: "C:\\demo",
          repo_root: "C:\\demo",
        },
        showSecondaryPanel: false,
        view: "project",
      }),
    );

    render(<AppLayout />);

    const chatButton = screen.getByTestId("activity-chat");

    fireEvent.click(chatButton);
    expect(useAppStore.getState().showSecondaryPanel).toBe(true);
    expect(useChatStore.getState().chatFocusMode).toBe(false);
    expect(screen.queryByTestId("chat-focus-shell")).not.toBeInTheDocument();

    fireEvent.click(chatButton);
    expect(useAppStore.getState().showSecondaryPanel).toBe(true);
    expect(useChatStore.getState().chatFocusMode).toBe(true);
    expect(screen.getByTestId("chat-focus-shell")).toBeInTheDocument();

    fireEvent.click(chatButton);
    expect(useAppStore.getState().showSecondaryPanel).toBe(true);
    expect(useChatStore.getState().chatFocusMode).toBe(false);
    expect(screen.queryByTestId("chat-focus-shell")).not.toBeInTheDocument();

    fireEvent.click(chatButton);
    expect(useAppStore.getState().showSecondaryPanel).toBe(false);
    expect(useChatStore.getState().chatFocusMode).toBe(false);
    expect(screen.queryByTestId("chat-focus-shell")).not.toBeInTheDocument();
  });

  it("docks the companion beside the editor layer only in document views", () => {
    act(() => useAppStore.setState({ view: "project", showSecondaryPanel: true }));
    render(<AppLayout />);

    const layer = screen.getByTestId("editor-layer");
    const companion = screen.getByTestId("secondary-chat-panel");
    expect(layer.parentElement).toContainElement(companion);
    expect(layer).toHaveClass("rounded-card", "border", "mb-[var(--card-gap)]");
    expect(layer).not.toHaveClass("mr-[var(--card-gap)]");
    expect(companion).toHaveClass("rounded-card", "border", "mb-[var(--card-gap)]", "mr-[var(--card-gap)]");

    act(() => useAppStore.setState({ showSecondaryPanel: false }));
    expect(screen.queryByTestId("secondary-chat-panel")).not.toBeInTheDocument();
    expect(layer).toHaveClass("rounded-card", "mr-[var(--card-gap)]");

    act(() => useAppStore.setState({ view: "home", showSecondaryPanel: true }));
    expect(screen.queryByTestId("secondary-chat-panel")).not.toBeInTheDocument();

    act(() => {
      useVersioningStore.setState({ isMerging: true });
      useAppStore.setState({ view: "project" });
    });
    expect(screen.queryByTestId("secondary-chat-panel")).not.toBeInTheDocument();
    act(() => useVersioningStore.setState({ isMerging: false }));
  });
});

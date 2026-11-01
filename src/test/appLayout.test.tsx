import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ isMac: false }));

vi.mock("../components/TitleBar", () => ({
  TitleBar: () => <div data-testid="titlebar" />,
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
  Sidebar: ({ onChatToggle }: { onChatToggle?: () => void }) => (
    <button type="button" data-testid="activity-chat" onClick={onChatToggle}>
      Chat
    </button>
  ),
}));
vi.mock("../components/StoryboardPanel", () => ({
  StoryboardPanel: () => <div />,
}));
vi.mock("../components/StoryboardList", () => ({
  StoryboardList: () => <div />,
  PrimarySidebar: () => <div />,
}));
vi.mock("../components/AssetList", () => ({
  AssetList: () => <div />,
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
vi.mock("../components/ChangesPanel", () => ({
  ChangesPanel: () => <div />,
}));
vi.mock("../components/FeedbackDialog", () => ({
  FeedbackDialog: () => null,
}));
vi.mock("../services/commandRegistry", () => ({
  commandRegistry: {
    execute: vi.fn(),
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
});

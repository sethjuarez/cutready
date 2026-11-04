import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/tauri", () => ({
  invoke: vi.fn(async () => null),
  listen: vi.fn(async () => () => {}),
  once: vi.fn(),
  emit: vi.fn(),
  emitTo: vi.fn(),
  convertFileSrc: vi.fn((path: string) => path),
  Channel: class {},
}));

import { useAppStore, type AppView } from "../stores/appStore";
import { hidesEditor } from "../utils/navigation";

const original = useAppStore.getState();

afterEach(() => useAppStore.setState(original, true));

describe("leaving the Media library for a document", () => {
  it("knows which views cover the editor", () => {
    const covering: AppView[] = ["assets", "narrations", "home", "settings", "chat"];
    for (const view of covering) expect(hidesEditor(view), view).toBe(true);
    expect(hidesEditor("project")).toBe(false);
    expect(hidesEditor("changes")).toBe(false);
  });

  it.each<AppView>(["assets", "narrations"])("opening a tab from %s shows the editor", (view) => {
    useAppStore.setState({ view, openTabs: [], activeTabId: null });
    useAppStore.getState().openTab({ type: "storyboard", path: "a.sb", title: "A" });
    expect(useAppStore.getState().view).toBe("project");
    expect(useAppStore.getState().activeTabId).not.toBeNull();
  });

  it("re-opening an already open tab from Media shows the editor", () => {
    useAppStore.setState({ view: "project", openTabs: [], activeTabId: null });
    useAppStore.getState().openTab({ type: "storyboard", path: "a.sb", title: "A" });
    useAppStore.setState({ view: "assets" });
    useAppStore.getState().openTab({ type: "storyboard", path: "a.sb", title: "A" });
    expect(useAppStore.getState().view).toBe("project");
  });

  it("switching tabs from Media shows the editor", () => {
    useAppStore.setState({ view: "project", openTabs: [], activeTabId: null });
    useAppStore.getState().openTab({ type: "storyboard", path: "a.sb", title: "A" });
    const id = useAppStore.getState().activeTabId!;
    useAppStore.setState({ view: "assets", openStoryboard: vi.fn(async () => {}) });
    useAppStore.getState().setActiveTab(id);
    expect(useAppStore.getState().view).toBe("project");
  });

  it("keeps the Changes view when a tab opens there", () => {
    useAppStore.setState({ view: "changes", openTabs: [], activeTabId: null });
    useAppStore.getState().openTab({ type: "storyboard", path: "a.sb", title: "A" });
    expect(useAppStore.getState().view).toBe("changes");
  });
});

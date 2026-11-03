import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  DEFAULT_ZOOM,
  SCHEMA_VERSION,
  STORAGE_KEY,
  defaultAccessibilitySettings,
  resolvePreference,
  sanitizeAccessibilitySettings,
  serializeAccessibilitySettings,
  stepZoom,
  trafficLightSpace,
} from "../accessibility/settings";
import {
  resolvedDifferentiateWithoutColor,
  resolvedIncreaseContrast,
  shortcutsEnabled,
  useAccessibilityStore,
} from "../stores/accessibilityStore";
import { applyAccessibilityAttributes, createSystemReader, zoomForShortcut } from "../accessibility/useApplyAccessibility";
import { createZoomQueue } from "../accessibility/zoom";
import { createActivityClassifier, shouldAnnounce, toolCategory } from "../accessibility/activityAnnouncements";
import { toastDuration, useToastStore } from "../stores/toastStore";
import { AccessibilityTab } from "../components/settings/AccessibilityTab";
import type { AgentEvent } from "../ipc/events";

function resetStore() {
  localStorage.removeItem(STORAGE_KEY);
  useAccessibilityStore.setState({
    settings: defaultAccessibilitySettings(false),
    system: { increaseContrast: false, differentiateWithoutColor: false, prefersContrastMore: false },
  });
}

describe("accessibility settings sanitize and migrate", () => {
  it("returns defaults for missing, corrupt, or non-object input", () => {
    for (const raw of [null, undefined, "", "{not json", "42", "[1,2]", 7]) {
      expect(sanitizeAccessibilitySettings(raw, false)).toEqual(defaultAccessibilitySettings(false));
    }
  });

  it("defaults tri-states to system on mac and off elsewhere", () => {
    expect(defaultAccessibilitySettings(true).increaseContrast).toBe("system");
    expect(defaultAccessibilitySettings(false).increaseContrast).toBe("off");
    expect(defaultAccessibilitySettings(false).errorToastMs).toBe(10_000);
    expect(defaultAccessibilitySettings(false).updateToastMs).toBe(5_000);
  });

  it("falls back per field so one bad value keeps the rest", () => {
    const result = sanitizeAccessibilitySettings(
      { zoom: 133, pointerOnHover: true, showUnderlines: "yes", errorToastMs: 0, updateToastMs: 1234, announce: { readingFiles: true, reasoning: "x" } },
      false,
    );
    expect(result.zoom).toBe(DEFAULT_ZOOM);
    expect(result.pointerOnHover).toBe(true);
    expect(result.showUnderlines).toBe(false);
    expect(result.errorToastMs).toBe(0);
    expect(result.updateToastMs).toBe(5_000);
    expect(result.announce.readingFiles).toBe(true);
    expect(result.announce.reasoning).toBe(true);
  });

  it("drops system off mac and keeps it on mac", () => {
    expect(sanitizeAccessibilitySettings({ increaseContrast: "system" }, false).increaseContrast).toBe("off");
    expect(sanitizeAccessibilitySettings({ increaseContrast: "system" }, true).increaseContrast).toBe("system");
    expect(sanitizeAccessibilitySettings({ increaseContrast: "on" }, false).increaseContrast).toBe("on");
  });

  it("round-trips the versioned wrapper and rejects a newer schema", () => {
    const settings = { ...defaultAccessibilitySettings(false), zoom: 125, keyboardShortcuts: false };
    const stored = serializeAccessibilitySettings(settings);
    expect(JSON.parse(stored).version).toBe(SCHEMA_VERSION);
    expect(sanitizeAccessibilitySettings(stored, false)).toEqual(settings);
    expect(sanitizeAccessibilitySettings({ version: SCHEMA_VERSION + 1, settings }, false)).toEqual(
      defaultAccessibilitySettings(false),
    );
  });
});

describe("accessibility store", () => {
  beforeEach(resetStore);

  it("persists updates and sanitizes them", () => {
    useAccessibilityStore.getState().update("zoom", 150);
    useAccessibilityStore.getState().update("zoom", 999);
    expect(useAccessibilityStore.getState().settings.zoom).toBe(DEFAULT_ZOOM);
    useAccessibilityStore.getState().update("pointerOnHover", true);
    useAccessibilityStore.setState({ settings: defaultAccessibilitySettings(false) });
    useAccessibilityStore.getState().reload();
    expect(useAccessibilityStore.getState().settings.pointerOnHover).toBe(true);
  });

  it("follows writes from other windows", () => {
    localStorage.setItem(STORAGE_KEY, serializeAccessibilitySettings({ ...defaultAccessibilitySettings(false), showUnderlines: true }));
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    expect(useAccessibilityStore.getState().settings.showUnderlines).toBe(true);
  });

  it("reload falls back to defaults on corrupt storage", () => {
    localStorage.setItem(STORAGE_KEY, "{oops");
    useAccessibilityStore.getState().reload();
    expect(useAccessibilityStore.getState().settings).toEqual(defaultAccessibilitySettings(false));
  });
});

describe("preference resolution", () => {
  it("resolves system/on/off", () => {
    expect(resolvePreference("on", false)).toBe(true);
    expect(resolvePreference("off", true)).toBe(false);
    expect(resolvePreference("system", true)).toBe(true);
    expect(resolvePreference("system", false)).toBe(false);
  });

  it("system contrast follows the OS or prefers-contrast", () => {
    const settings = { ...defaultAccessibilitySettings(true) };
    const base = { increaseContrast: false, differentiateWithoutColor: false, prefersContrastMore: false };
    expect(resolvedIncreaseContrast({ settings, system: base })).toBe(false);
    expect(resolvedIncreaseContrast({ settings, system: { ...base, increaseContrast: true } })).toBe(true);
    expect(resolvedIncreaseContrast({ settings, system: { ...base, prefersContrastMore: true } })).toBe(true);
    expect(resolvedDifferentiateWithoutColor({ settings, system: { ...base, differentiateWithoutColor: true } })).toBe(true);
    expect(
      resolvedIncreaseContrast({ settings: { ...settings, increaseContrast: "off" }, system: { ...base, increaseContrast: true } }),
    ).toBe(false);
  });

  it("applies OS change events and drops a stale initial read", async () => {
    const applied: boolean[] = [];
    let resolveFirst!: (v: { increaseContrast: boolean; differentiateWithoutColor: boolean }) => void;
    const reads = [
      new Promise<{ increaseContrast: boolean; differentiateWithoutColor: boolean }>((r) => (resolveFirst = r)),
      Promise.resolve({ increaseContrast: true, differentiateWithoutColor: false }),
    ];
    let call = 0;
    const refresh = createSystemReader(
      () => reads[call++],
      (v) => applied.push(v.increaseContrast),
    );
    const first = refresh();
    await refresh();
    resolveFirst({ increaseContrast: false, differentiateWithoutColor: false });
    await first;
    expect(applied).toEqual([true]);
  });

  it("treats a failed or empty OS read as no change", async () => {
    const apply = vi.fn();
    await createSystemReader(() => Promise.reject(new Error("nope")), apply)();
    await createSystemReader(() => Promise.resolve(null), apply)();
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("attribute effects", () => {
  it("toggles html classes and data attributes", () => {
    const root = document.createElement("html");
    applyAccessibilityAttributes(root, { pointerOnHover: true, showUnderlines: true, increaseContrast: true, differentiateWithoutColor: true });
    expect(root.classList.contains("pointer-on-hover")).toBe(true);
    expect(root.hasAttribute("data-show-underlines")).toBe(true);
    expect(root.hasAttribute("data-increase-contrast")).toBe(true);
    expect(root.hasAttribute("data-differentiate-without-color")).toBe(true);
    applyAccessibilityAttributes(root, { pointerOnHover: false, showUnderlines: false, increaseContrast: false, differentiateWithoutColor: false });
    expect(root.classList.contains("pointer-on-hover")).toBe(false);
    expect(root.hasAttribute("data-show-underlines")).toBe(false);
    expect(root.hasAttribute("data-increase-contrast")).toBe(false);
    expect(root.hasAttribute("data-differentiate-without-color")).toBe(false);
  });
});

describe("toast durations", () => {
  beforeEach(() => {
    resetStore();
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => vi.useRealTimers());

  it("errors use the error setting, others keep their requested time", () => {
    useAccessibilityStore.getState().update("errorToastMs", 30_000);
    expect(toastDuration("error", 3000)).toBe(30_000);
    expect(toastDuration("success", 3000)).toBe(3000);
  });

  it("indefinite errors stay until dismissed", () => {
    useAccessibilityStore.getState().update("errorToastMs", 0);
    useToastStore.getState().show("Broke", 3000, "error");
    vi.advanceTimersByTime(60 * 60_000);
    const [toast] = useToastStore.getState().toasts;
    expect(toast.message).toBe("Broke");
    useToastStore.getState().dismiss(toast.id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("update toasts use the update setting", () => {
    useAccessibilityStore.getState().update("updateToastMs", 60_000);
    useToastStore.getState().showUpdate("Incoming saves merged.", "success");
    vi.advanceTimersByTime(59_000);
    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ message: "Incoming saves merged.", type: "success" })]);
    vi.advanceTimersByTime(1_000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});

describe("announcer gating", () => {
  const enabled = defaultAccessibilitySettings(false).announce;
  const ev = (e: Partial<AgentEvent> & { type: AgentEvent["type"] }) => e as AgentEvent;

  it("classifies tools", () => {
    expect(toolCategory("read_sketch")).toBe("readingFiles");
    expect(toolCategory("update_planning_row")).toBe("editingDocuments");
    expect(toolCategory("web_research")).toBe("toolCalls");
    expect(toolCategory("search_web")).toBe("toolCalls");
    expect(toolCategory("fetch_url")).toBe("toolCalls");
    expect(toolCategory("recall_memory")).toBe("toolCalls");
  });

  it("announces thinking once per streak", () => {
    const classify = createActivityClassifier();
    expect(classify(ev({ type: "thinking" }))?.text).toBe("Thinking");
    expect(classify(ev({ type: "thinking" }))).toBeNull();
    classify(ev({ type: "delta" }));
    expect(classify(ev({ type: "thinking" }))?.text).toBe("Thinking");
  });

  it("respects defaults: tool calls and finishes on, reads and edits off", () => {
    const classify = createActivityClassifier();
    const run = ev({ type: "tool_call", name: "web_research" });
    const read = ev({ type: "tool_call", name: "read_sketch" });
    const readDone = ev({ type: "tool_result", name: "read_sketch" });
    const runDone = ev({ type: "tool_result", name: "web_research", status: "failure" });
    expect(shouldAnnounce(classify(run)!, run, enabled)).toBe(true);
    expect(shouldAnnounce(classify(read)!, read, enabled)).toBe(false);
    expect(shouldAnnounce(classify(readDone)!, readDone, enabled)).toBe(false);
    const done = classify(runDone)!;
    expect(done.text).toBe("web research failed");
    expect(shouldAnnounce(done, runDone, enabled)).toBe(true);
    const agent = ev({ type: "agent_start", agent_id: "Writer" });
    expect(shouldAnnounce(classify(agent)!, agent, enabled)).toBe(false);
    expect(shouldAnnounce(classify(agent)!, agent, { ...enabled, agentChange: true })).toBe(true);
  });

  it("silences a category the user turned off", () => {
    const classify = createActivityClassifier();
    const think = ev({ type: "thinking" });
    expect(shouldAnnounce(classify(think)!, think, { ...enabled, reasoning: false })).toBe(false);
  });
});

describe("keyboard shortcut gate", () => {
  beforeEach(resetStore);

  it("reads the current setting at dispatch time", () => {
    expect(shortcutsEnabled()).toBe(true);
    useAccessibilityStore.getState().update("keyboardShortcuts", false);
    expect(shortcutsEnabled()).toBe(false);
  });
});

describe("zoom", () => {
  it("steps through levels, clamps, and snaps off-list values", () => {
    expect(stepZoom(100, 1)).toBe(110);
    expect(stepZoom(100, -1)).toBe(90);
    expect(stepZoom(200, 1)).toBe(200);
    expect(stepZoom(75, -1)).toBe(75);
    expect(stepZoom(105, 1)).toBe(110);
    expect(stepZoom(105, -1)).toBe(100);
  });

  it("maps shortcuts, including reset", () => {
    const key = (k: string, mods: Partial<KeyboardEvent> = { ctrlKey: true }) =>
      ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods }) as KeyboardEvent;
    expect(zoomForShortcut(key("="), 100)).toBe(110);
    expect(zoomForShortcut(key("+"), 100)).toBe(110);
    expect(zoomForShortcut(key("-", { metaKey: true }), 100)).toBe(90);
    expect(zoomForShortcut(key("0"), 150)).toBe(DEFAULT_ZOOM);
    expect(zoomForShortcut(key("=", {}), 100)).toBeNull();
    expect(zoomForShortcut(key("=", { ctrlKey: true, altKey: true }), 100)).toBeNull();
  });

  it("keeps the macOS traffic lights at a fixed physical gap", () => {
    expect(trafficLightSpace(100)).toBe(92);
    expect(trafficLightSpace(200)).toBe(46);
  });

  it("serializes native calls and coalesces bursts to the last level", async () => {
    const calls: number[] = [];
    let release!: () => void;
    const setter = vi.fn((factor: number) => {
      calls.push(factor);
      return calls.length === 1 ? new Promise<void>((r) => (release = r)) : Promise.resolve();
    });
    const queue = createZoomQueue(setter);
    const done = queue.request(110);
    queue.request(125);
    queue.request(150);
    release();
    await done;
    expect(calls).toEqual([1.1, 1.5]);
    await queue.request(150);
    expect(calls).toEqual([1.1, 1.5]);
  });

  it("reports only zoom levels that took effect", async () => {
    const applied: number[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const queue = createZoomQueue((factor) => (factor > 1.5 ? Promise.reject(new Error("denied")) : Promise.resolve()), (p) => applied.push(p));
    await queue.request(125);
    await queue.request(200);
    expect(applied).toEqual([125]);
    warn.mockRestore();
  });
});

describe("AccessibilityTab", () => {
  beforeEach(resetStore);

  it("renders the sections and shows Reset only when zoomed", () => {
    render(<AccessibilityTab />);
    for (const name of ["Display", "Notifications", "Announcements", "Keyboard"]) {
      expect(screen.getByRole("heading", { name })).toBeTruthy();
    }
    expect(screen.queryByTestId("a11y-zoom-reset")).toBeNull();
    fireEvent.change(screen.getByTestId("a11y-zoom"), { target: { value: "125" } });
    expect(useAccessibilityStore.getState().settings.zoom).toBe(125);
    act(() => screen.getByTestId("a11y-zoom-reset").click());
    expect(useAccessibilityStore.getState().settings.zoom).toBe(100);
  });

  it("switches are labelled and toggle settings", () => {
    render(<AccessibilityTab />);
    const pointer = screen.getByRole("switch", { name: "Show pointer on hover" });
    expect(pointer.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(pointer);
    expect(useAccessibilityStore.getState().settings.pointerOnHover).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Reading files" }));
    expect(useAccessibilityStore.getState().settings.announce.readingFiles).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Increase contrast" }));
    expect(useAccessibilityStore.getState().settings.increaseContrast).toBe("on");
  });
});

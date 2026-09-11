import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The picker (and the SettingsPanel module it lives in) reaches Tauri only
// through ../services/tauri. Replace the whole module so importing SettingsPanel
// in jsdom never touches the real IPC bridge. Any importer in the graph that
// pulls a name at eval time gets a harmless stub.
vi.mock("../services/tauri", () => ({
  invoke: vi.fn(),
  convertFileSrc: (p: string) => p,
  Channel: class {},
  listen: vi.fn().mockResolvedValue(() => {}),
  once: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
  emitTo: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "../services/tauri";
import { HarnessPicker } from "../components/SettingsPanel";

/** Minimal harness descriptor matching what `list_agent_harnesses` returns. */
function descriptor(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    display_name: id === "prompty" ? "Prompty" : id,
    streaming: true,
    tool_calls: true,
    vision: false,
    web_search: false,
    delegation: false,
    steering: false,
    cancellation: true,
    durable_state: true,
    contract: { provider: "requires", personas: "requires", tools: "requires", memory: "requires" },
    available: true,
    ...extra,
  };
}

function mockHarnesses(list: ReturnType<typeof descriptor>[]) {
  vi.mocked(invoke).mockImplementation((cmd: string) =>
    cmd === "list_agent_harnesses"
      ? Promise.resolve(list as unknown)
      : Promise.resolve(undefined as unknown),
  );
}

describe("HarnessPicker unavailable-selection handling", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("warns and offers a one-click switch to Prompty when the saved harness isn't compiled in", async () => {
    mockHarnesses([descriptor("prompty"), descriptor("agentive")]);
    const onChange = vi.fn();
    render(<HarnessPicker value="nonexistent-harness" onChange={onChange} />);

    // The explicit warning renders (text lives in one node after the value span).
    await screen.findByText(/the run will fail/i);

    const button = screen.getByRole("button", { name: /switch to prompty/i });
    fireEvent.click(button);
    expect(onChange).toHaveBeenCalledWith("prompty");
  });

  it("does not warn when the saved harness is known", async () => {
    mockHarnesses([descriptor("prompty"), descriptor("agentive")]);
    render(<HarnessPicker value="prompty" onChange={vi.fn()} />);

    await screen.findByText("Prompty"); // wait for the list to load
    expect(screen.queryByText(/the run will fail/i)).toBeNull();
  });

  it("treats a blank saved value as Prompty (no spurious warning)", async () => {
    // Mirrors the backend canonical_id: empty/whitespace resolves to Prompty.
    mockHarnesses([descriptor("prompty"), descriptor("agentive")]);
    render(<HarnessPicker value="   " onChange={vi.fn()} />);

    await screen.findByText("Prompty");
    expect(screen.queryByText(/the run will fail/i)).toBeNull();
  });

  it("falls back to the first available harness when Prompty isn't present", async () => {
    mockHarnesses([
      descriptor("agentive", { available: false, display_name: "Agentive" }),
      descriptor("other-engine", { available: true, display_name: "Other Engine" }),
    ]);
    const onChange = vi.fn();
    render(<HarnessPicker value="zzz" onChange={onChange} />);

    const button = await screen.findByRole("button", { name: /switch to other engine/i });
    fireEvent.click(button);
    expect(onChange).toHaveBeenCalledWith("other-engine");
  });

  // These data-testid handles are the contract the Auditaur settings drill drives
  // against. If a refactor drops one, the E2E drill would fail opaquely at runtime;
  // this locks the handles at the unit layer so a break is caught deterministically.
  it("exposes stable data-testid handles for E2E drills", async () => {
    mockHarnesses([descriptor("prompty"), descriptor("copilot-sdk", { display_name: "GitHub Copilot" })]);
    const { container } = render(<HarnessPicker value="mystery-engine" onChange={vi.fn()} />);

    // Picker root + one option card per harness, tagged by canonical id.
    await screen.findByTestId("harness-picker");
    expect(container.querySelector('[data-testid="harness-option-prompty"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="harness-option-copilot-sdk"]')).not.toBeNull();

    // Unknown selection surfaces the warning + actionable switch handle.
    expect(await screen.findByTestId("harness-unavailable-warning")).toBeTruthy();
    expect(await screen.findByTestId("harness-switch-fallback")).toBeTruthy();
  });

  it("marks the active harness card via data-selected", async () => {
    mockHarnesses([descriptor("prompty"), descriptor("agentive")]);
    const { container } = render(<HarnessPicker value="prompty" onChange={vi.fn()} />);

    await screen.findByTestId("harness-option-prompty");
    expect(
      container.querySelector('[data-testid="harness-option-prompty"]')?.getAttribute("data-selected"),
    ).toBe("true");
    expect(
      container.querySelector('[data-testid="harness-option-agentive"]')?.getAttribute("data-selected"),
    ).toBe("false");
    expect(screen.queryByTestId("harness-unavailable-warning")).toBeNull();
  });

  it("badges an experimental harness and shows a caveat when it's active", async () => {
    mockHarnesses([
      descriptor("prompty", { stability: "stable" }),
      descriptor("other-engine", { stability: "experimental", display_name: "Other Engine" }),
    ]);
    const { container } = render(<HarnessPicker value="other-engine" onChange={vi.fn()} />);

    await screen.findByTestId("harness-option-prompty");
    // An experimental adapter carries the badge; the stable default does not.
    expect(container.querySelector('[data-testid="harness-experimental-other-engine"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="harness-experimental-prompty"]')).toBeNull();
    // Because it's the active selection, the inline caveat is shown.
    expect(container.querySelector('[data-testid="harness-experimental-note-other-engine"]')).not.toBeNull();
  });

  it("hides the experimental caveat when the experimental harness isn't active", async () => {
    mockHarnesses([
      descriptor("prompty", { stability: "stable" }),
      descriptor("other-engine", { stability: "experimental", display_name: "Other Engine" }),
    ]);
    const { container } = render(<HarnessPicker value="prompty" onChange={vi.fn()} />);

    await screen.findByTestId("harness-option-other-engine");
    // Badge still shows on the card, but the active-only caveat does not.
    expect(container.querySelector('[data-testid="harness-experimental-other-engine"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="harness-experimental-note-other-engine"]')).toBeNull();
  });
});

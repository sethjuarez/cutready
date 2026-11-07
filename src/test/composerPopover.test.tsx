import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunDetailsPopover } from "../components/chat/RunDetailsPopover";

function placeTrigger(rect: Partial<DOMRect>) {
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}), ...rect,
  } as DOMRect);
}

function renderInClippedPanel() {
  return render(
    <div data-testid="chat-panel" style={{ overflow: "hidden" }}>
      <RunDetailsPopover details={{ execution_engine: "chat", agent_id: "writer", model: "gpt-5.6-terra", provider: "microsoft_foundry" }} status="Configured" />
    </div>,
  );
}

describe("composer popovers", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens run details outside the clipping chat panel, above the trigger and inside the window", () => {
    // A trigger near the window's left edge: right-aligned, the 288px popover would start off-screen.
    placeTrigger({ top: 600, bottom: 620, left: 100, right: 120 });
    renderInClippedPanel();

    fireEvent.click(screen.getByRole("button", { name: "Show run details" }));
    const dialog = screen.getByRole("dialog", { name: "Run details" });

    expect(screen.getByTestId("chat-panel")).not.toContainElement(dialog);
    expect(dialog.style.position).toBe("fixed");
    expect(dialog.style.left).toBe("8px");
    expect(dialog.style.bottom).toBe(`${window.innerHeight - 600 + 4}px`);
    expect(dialog).toHaveTextContent("Microsoft Foundry");
  });

  it("caps its height to the room above the trigger", () => {
    placeTrigger({ top: 150, bottom: 170, left: 400, right: 420 });
    renderInClippedPanel();
    fireEvent.click(screen.getByRole("button", { name: "Show run details" }));
    expect(screen.getByRole("dialog", { name: "Run details" }).style.maxHeight).toBe("138px");
  });

  it("closes on Escape and on a click outside, but not on a click inside", () => {
    placeTrigger({ top: 600, bottom: 620, left: 400, right: 420 });
    renderInClippedPanel();
    const trigger = screen.getByRole("button", { name: "Show run details" });

    fireEvent.click(trigger);
    fireEvent.mouseDown(screen.getByRole("dialog", { name: "Run details" }));
    expect(screen.getByRole("dialog", { name: "Run details" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Run details" })).toBeNull();

    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Run details" })).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});

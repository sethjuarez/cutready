import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResizeHandle } from "../components/ResizeHandle";

afterEach(cleanup);

describe("ResizeHandle keyboard and pointer contract", () => {
  it("steps with arrows (Shift for 50px), resets on double-click and reports its value", () => {
    const onStep = vi.fn();
    const onReset = vi.fn();
    render(
      <ResizeHandle
        direction="horizontal"
        onResize={vi.fn()}
        onStep={onStep}
        onReset={onReset}
        ariaLabel="Resize sidebar"
        value={{ now: 280, min: 220, max: 480 }}
        controls="app-sidebar"
      />,
    );
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });
    expect(handle).toHaveAttribute("tabindex", "0");
    expect(handle).toHaveAttribute("aria-valuenow", "280");
    expect(handle).toHaveAttribute("aria-valuemin", "220");
    expect(handle).toHaveAttribute("aria-valuemax", "480");
    expect(handle).toHaveAttribute("aria-controls", "app-sidebar");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(onStep.mock.calls).toEqual([[10], [-50]]);
    fireEvent.doubleClick(handle);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("restores the page and ends the drag when unmounted mid-drag", () => {
    const onResizeEnd = vi.fn();
    const { unmount } = render(<ResizeHandle direction="horizontal" onResize={vi.fn()} onResizeEnd={onResizeEnd} />);
    const handle = screen.getByTestId("resize-handle-horizontal");
    handle.setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    expect(document.body.style.userSelect).toBe("none");

    unmount();
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.cursor).toBe("");
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
  });
});
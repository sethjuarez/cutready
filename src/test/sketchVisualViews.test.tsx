import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SketchBalancedView } from "../components/SketchVisualViews";
import type { PlanningRow } from "../types/sketch";

vi.mock("../services/tauri", () => ({
  invoke: vi.fn(),
}));

vi.mock("../components/VisualCell", () => ({
  default: () => <div data-testid="visual-cell" />,
}));

vi.mock("../hooks/useProjectImage", () => ({
  useProjectImage: () => "",
}));

describe("SketchVisualViews", () => {
  it("allows adding a new row after a locked last row", () => {
    const rows: PlanningRow[] = [{
      time: "~0:20",
      narrative: "Locked narrative",
      demo_actions: "Locked action",
      screenshot: null,
      locked: true,
    }];
    const onChange = vi.fn();

    render(<SketchBalancedView rows={rows} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Add Row" }));

    expect(onChange).toHaveBeenCalledWith([
      rows[0],
      {
        time: "",
        narrative: "",
        demo_actions: "",
        screenshot: null,
      },
    ]);
  });

  it("confirms before removing a row in visual mode", async () => {
    const rows: PlanningRow[] = [
      {
        time: "~0:20",
        narrative: "Intro",
        demo_actions: "Show intro",
        screenshot: null,
      },
      {
        time: "~0:40",
        narrative: "Demo",
        demo_actions: "Show demo",
        screenshot: null,
      },
    ];
    const onChange = vi.fn();

    render(<SketchBalancedView rows={rows} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove row 1" }));
    expect(onChange).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Remove row?")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove row" }));
      await Promise.resolve();
    });

    expect(onChange).toHaveBeenCalledWith([rows[1]]);
  });
});

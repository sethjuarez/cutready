import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScriptTable } from "../components/ScriptTable";
import type { PlanningRow } from "../types/sketch";

function filledRow(time: string, narrative: string, actions: string): PlanningRow {
  return { time, narrative, demo_actions: actions, screenshot: null };
}

/** Get all data-tab-cell wrappers in document order */
function getTabCells() {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-tab-cell]")).sort(
    (a, b) =>
      parseInt(a.getAttribute("data-tab-cell")!, 10) -
      parseInt(b.getAttribute("data-tab-cell")!, 10),
  );
}

describe("ScriptTable tab order", () => {
  it("renders cells with sequential data-tab-cell attributes", () => {
    const rows = [filledRow("10s", "Hello", "Click"), filledRow("20s", "World", "Type")];
    render(<ScriptTable rows={rows} onChange={() => {}} />);

    const cells = getTabCells();
    expect(cells).toHaveLength(6); // 2 rows × 3 columns
    expect(cells.map((c) => c.getAttribute("data-tab-cell"))).toEqual([
      "0", "1", "2", "3", "4", "5",
    ]);
  });

  it("Tab from Time moves to Narrative in same row", async () => {
    const user = userEvent.setup();
    const rows = [filledRow("10s", "Hello", "Click")];
    render(<ScriptTable rows={rows} onChange={() => {}} />);

    // Focus the Time input (data-tab-cell=0)
    const timeInput = getTabCells()[0].querySelector("input")!;
    timeInput.focus();
    expect(document.activeElement).toBe(timeInput);

    // Tab should move to Narrative (data-tab-cell=1)
    await user.tab();
    const narrativeCell = getTabCells()[1];
    // Narrative is a MarkdownCell in preview mode — focus lands on the [data-cell] div
    expect(narrativeCell.contains(document.activeElement)).toBe(true);
  });

  it("Tab from Actions skips Screenshot and moves to next row Time", async () => {
    const user = userEvent.setup();
    const rows = [filledRow("10s", "Hello", "Click"), filledRow("20s", "World", "Type")];
    const onChange = vi.fn();
    render(<ScriptTable rows={rows} onChange={onChange} />);

    // Focus the Actions cell of row 0 — onFocus enters edit mode (textarea)
    const actionsCell = getTabCells()[2];
    const focusable = actionsCell.querySelector<HTMLElement>("[data-cell]") ??
      actionsCell.querySelector<HTMLElement>("input");
    focusable!.focus();

    // Wait for edit mode to render the textarea
    await new Promise((r) => setTimeout(r, 50));

    // Now Tab from the textarea — should move to next row's Time
    await user.tab();

    // Wait for requestAnimationFrame in Tab handler
    await new Promise((r) => setTimeout(r, 50));

    const nextTimeCell = getTabCells()[3];
    expect(nextTimeCell.contains(document.activeElement)).toBe(true);
  });

  it("Tab from last Actions cell triggers addRow", async () => {
    const user = userEvent.setup();
    const rows = [filledRow("10s", "Hello", "Click")];
    const onChange = vi.fn();
    render(<ScriptTable rows={rows} onChange={onChange} />);

    // Focus the Actions cell of row 0 (last row, data-tab-cell=2)
    const actionsCell = getTabCells()[2];
    const focusable = actionsCell.querySelector<HTMLElement>("[data-cell]") ??
      actionsCell.querySelector<HTMLElement>("input");
    focusable!.focus();

    // Wait for edit mode
    await new Promise((r) => setTimeout(r, 50));

    // Tab past the last cell — should trigger addRow via onChange
    await user.tab();

    // Wait for requestAnimationFrame in Tab handler
    await new Promise((r) => setTimeout(r, 50));

    // onChange should have been called with 2 rows (original + new empty)
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall).toHaveLength(2);
    expect(lastCall[1].time).toBe("");
    expect(lastCall[1].narrative).toBe("");
    expect(lastCall[1].demo_actions).toBe("");
  });

  it("Shift+Tab from Time moves to previous row Actions", async () => {
    const user = userEvent.setup();
    const rows = [filledRow("10s", "Hello", "Click"), filledRow("20s", "World", "Type")];
    render(<ScriptTable rows={rows} onChange={() => {}} />);

    // Focus row 1 Time (data-tab-cell=3)
    const timeInput = getTabCells()[3].querySelector("input")!;
    timeInput.focus();
    expect(document.activeElement).toBe(timeInput);

    // Shift+Tab should go to row 0 Actions (data-tab-cell=2)
    await user.tab({ shift: true });
    const prevActions = getTabCells()[2];
    expect(prevActions.contains(document.activeElement)).toBe(true);
  });

  it("Ctrl+Enter adds a new row below current", async () => {
    const user = userEvent.setup();
    const rows = [filledRow("10s", "A", "B"), filledRow("20s", "C", "D")];
    const onChange = vi.fn();
    render(<ScriptTable rows={rows} onChange={onChange} />);

    // Focus row 0 Time
    const timeInput = getTabCells()[0].querySelector("input")!;
    timeInput.focus();

    // Ctrl+Enter
    await user.keyboard("{Control>}{Enter}{/Control}");

    // onChange should insert a new row after index 0
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall).toHaveLength(3);
    expect(lastCall[0].time).toBe("10s");
    expect(lastCall[1].time).toBe(""); // new empty row
    expect(lastCall[2].time).toBe("20s");
  });

  it("Ctrl+Backspace deletes current row", async () => {
    const user = userEvent.setup();
    const rows = [filledRow("10s", "A", "B"), filledRow("20s", "C", "D")];
    const onChange = vi.fn();
    render(<ScriptTable rows={rows} onChange={onChange} />);

    // Focus row 1 Time
    const timeInput = getTabCells()[3].querySelector("input")!;
    timeInput.focus();

    // Ctrl+Backspace
    await user.keyboard("{Control>}{Backspace}{/Control}");

    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall).toHaveLength(1);
    expect(lastCall[0].time).toBe("10s");
  });
});

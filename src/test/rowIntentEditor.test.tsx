import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RowIntentEditor } from "../components/planning/RowIntentEditor";
import type { PlanningRow } from "../types/sketch";

function renderEditor(onFramingBeatsChange = vi.fn()) {
  const row = { id: "r1", time: "", narrative: "", demo_actions: "" } as PlanningRow;
  render(
    <RowIntentEditor
      rowIndex={0}
      row={row}
      demoStepsReadOnly={false}
      framingBeatsReadOnly={false}
      onDemoStepsChange={vi.fn()}
      onFramingBeatsChange={onFramingBeatsChange}
    />,
  );
  return { onFramingBeatsChange, textarea: screen.getByLabelText("Framing beats") };
}

function commit(textarea: HTMLElement, value: string) {
  fireEvent.focus(textarea);
  fireEvent.change(textarea, { target: { value } });
  fireEvent.blur(textarea);
}

describe("RowIntentEditor millisecond fields", () => {
  it.each([-1, 1.5, 4294967296])("rejects %s, which does not fit the u32 the backend stores", (ms) => {
    const { onFramingBeatsChange, textarea } = renderEditor();

    commit(textarea, JSON.stringify([{ kind: "hold", at_ms: 0, duration_ms: ms }]));

    expect(screen.getByText(/whole number of milliseconds/)).toBeTruthy();
    expect(onFramingBeatsChange).not.toHaveBeenCalled();
  });

  it("rejects an unknown wait edit policy, which Rust would refuse to load", () => {
    const row = { id: "r1", time: "", narrative: "", demo_actions: "" } as PlanningRow;
    const onDemoStepsChange = vi.fn();
    render(
      <RowIntentEditor rowIndex={0} row={row} demoStepsReadOnly={false} framingBeatsReadOnly={false}
        onDemoStepsChange={onDemoStepsChange} onFramingBeatsChange={vi.fn()} />,
    );

    commit(screen.getByLabelText("Demo steps"), JSON.stringify([{ kind: "wait_for", condition: "ready", edit_policy: "invalid" }]));

    expect(screen.getByText(/needs "edit_policy" as one of/)).toBeTruthy();
    expect(onDemoStepsChange).not.toHaveBeenCalled();
  });

  it("commits whole non-negative milliseconds", () => {
    const { onFramingBeatsChange, textarea } = renderEditor();

    commit(textarea, JSON.stringify([{ kind: "hold", at_ms: 0, duration_ms: 4294967295 }]));

    expect(onFramingBeatsChange).toHaveBeenCalledWith([{ kind: "hold", at_ms: 0, duration_ms: 4294967295 }]);
  });
});

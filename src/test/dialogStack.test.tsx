import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "../components/Dialog";

describe("stacked dialogs", () => {
  it("keeps only the top dialog modal and lets Escape close just that one", () => {
    const closeLower = vi.fn();
    const closeUpper = vi.fn();
    const { rerender } = render(
      <>
        <Dialog isOpen onClose={closeLower} labelledBy="lower"><h2 id="lower">Lower</h2></Dialog>
        <Dialog isOpen onClose={closeUpper} labelledBy="upper"><h2 id="upper">Upper</h2></Dialog>
      </>,
    );
    expect(screen.getAllByRole("dialog").map((d) => d.getAttribute("aria-labelledby"))).toEqual(["upper"]);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeUpper).toHaveBeenCalledOnce();
    expect(closeLower).not.toHaveBeenCalled();

    rerender(
      <>
        <Dialog isOpen onClose={closeLower} labelledBy="lower"><h2 id="lower">Lower</h2></Dialog>
        <Dialog isOpen={false} onClose={closeUpper} labelledBy="upper"><h2 id="upper">Upper</h2></Dialog>
      </>,
    );
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-labelledby", "lower");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeLower).toHaveBeenCalledOnce();
  });
});

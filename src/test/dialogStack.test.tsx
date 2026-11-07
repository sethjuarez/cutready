import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
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

  // Outside act, React commits the dialog before its stack effect runs; anything
  // watching the DOM (assistive tech, Testing Library's findBy) sees that commit.
  it("is exposed to assistive tech from its first commit", async () => {
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const actEnvironment = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      const hidden = await new Promise<string | null>((resolve) => {
        const observer = new MutationObserver(() => {
          const dialog = document.querySelector('[role="alertdialog"]');
          if (!dialog) return;
          observer.disconnect();
          resolve(dialog.parentElement?.getAttribute("aria-hidden") ?? null);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        root.render(<Dialog isOpen onClose={() => {}} role="alertdialog"><p>Remove?</p></Dialog>);
      });
      expect(hidden).toBeNull();
    } finally {
      root.unmount();
      host.remove();
      env.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
    }
  });
});

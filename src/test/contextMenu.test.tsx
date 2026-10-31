import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ContextMenu } from "../components/ContextMenu";

function renderMenu() {
  const rename = vi.fn();
  const moveToBeta = vi.fn();
  const onClose = vi.fn();
  render(
    <ContextMenu
      position={{ x: 10, y: 10 }}
      onClose={onClose}
      items={[
        { label: "Rename", action: rename },
        { label: "Disabled", disabled: true },
        { separator: true },
        { label: "Move to", submenu: [{ label: "Beta Project", action: moveToBeta }] },
      ]}
    />,
  );
  return { rename, moveToBeta, onClose };
}

describe("ContextMenu keyboard", () => {
  it("focuses the first enabled item and skips disabled items", () => {
    renderMenu();
    const rename = screen.getByRole("menuitem", { name: "Rename" });
    expect(rename).toHaveFocus();
    fireEvent.keyDown(rename, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Move to" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(rename).toHaveFocus();
  });

  it("activates the focused item with Enter", () => {
    const { rename, onClose } = renderMenu();
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(rename).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalled();
  });

  it("opens a submenu with ArrowRight and returns with ArrowLeft", () => {
    const { moveToBeta } = renderMenu();
    const moveTo = screen.getByRole("menuitem", { name: "Move to" });
    moveTo.focus();
    fireEvent.keyDown(moveTo, { key: "ArrowRight" });
    expect(moveTo).toHaveAttribute("aria-expanded", "true");
    const beta = screen.getByRole("menuitem", { name: "Beta Project" });
    expect(beta).toHaveFocus();
    fireEvent.keyDown(beta, { key: "ArrowLeft" });
    expect(moveTo).toHaveFocus();
    expect(moveTo).toHaveAttribute("aria-expanded", "false");
    expect(moveToBeta).not.toHaveBeenCalled();
  });

  it("restores focus to the opener when closed", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(
      <ContextMenu position={{ x: 0, y: 0 }} onClose={() => {}} items={[{ label: "Rename" }]} />,
    );
    expect(opener).not.toHaveFocus();
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});

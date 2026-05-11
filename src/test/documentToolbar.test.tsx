import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocumentToolbar } from "../components/DocumentToolbar";

describe("DocumentToolbar", () => {
  it("runs grouped actions from dropdown menus", () => {
    const onPreview = vi.fn();

    render(
      <DocumentToolbar
        canRecord
        onRecord={vi.fn()}
        presentActions={[{ id: "preview", label: "Preview", onSelect: onPreview }]}
        locked={false}
        onToggleLock={vi.fn()}
        lockLabel="Lock sketch"
        unlockLabel="Unlock sketch"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /present/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /preview/i }));

    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("does not run disabled record or menu actions", () => {
    const onRecord = vi.fn();
    const onDisabledAction = vi.fn();

    render(
      <DocumentToolbar
        canRecord={false}
        onRecord={onRecord}
        presentActions={[{ id: "preview", label: "Preview", onSelect: onDisabledAction, disabled: true }]}
        locked={false}
        onToggleLock={vi.fn()}
        lockLabel="Lock sketch"
        unlockLabel="Unlock sketch"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /record/i }));
    fireEvent.click(screen.getByRole("button", { name: /present/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /preview/i }));

    expect(onRecord).not.toHaveBeenCalled();
    expect(onDisabledAction).not.toHaveBeenCalled();
  });

  it("closes an open menu with Escape and toggles lock", () => {
    const onToggleLock = vi.fn();

    render(
      <DocumentToolbar
        canRecord
        onRecord={vi.fn()}
        presentActions={[{ id: "preview", label: "Preview", onSelect: vi.fn() }]}
        locked
        onToggleLock={onToggleLock}
        lockLabel="Lock storyboard"
        unlockLabel="Unlock storyboard"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /present/i }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /unlock storyboard/i }));
    expect(onToggleLock).toHaveBeenCalledTimes(1);
  });
});

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentToolbar } from "../components/DocumentToolbar";

function stubResizeObserver() {
  let callback: ResizeObserverCallback | null = null;
  const observe = vi.fn();
  const disconnect = vi.fn();

  class MockResizeObserver {
    constructor(cb: ResizeObserverCallback) {
      callback = cb;
    }

    observe = observe;
    disconnect = disconnect;
  }

  vi.stubGlobal("ResizeObserver", MockResizeObserver);

  return {
    resize(width: number) {
      act(() => {
        callback?.(
          [{ contentRect: { width } } as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });
    },
    observe,
    disconnect,
  };
}

describe("DocumentToolbar", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("does not render duplicate wide and overflow action controls", () => {
    render(
      <DocumentToolbar
        canRecord
        onRecord={vi.fn()}
        presentActions={[{ id: "preview", label: "Preview", onSelect: vi.fn() }]}
        aiActions={[{ id: "polish", label: "Polish", onSelect: vi.fn() }]}
        exportActions={[{ id: "word", label: "Word", onSelect: vi.fn() }]}
        locked={false}
        onToggleLock={vi.fn()}
        lockLabel="Lock sketch"
        unlockLabel="Unlock sketch"
      />,
    );

    expect(screen.queryByRole("button", { name: /more document actions/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /present/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ai actions/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /export actions/i })).toBeInTheDocument();
  });

  it("switches between wide action menus and a single compact overflow menu", () => {
    const observer = stubResizeObserver();

    render(
      <div className="document-header">
        <DocumentToolbar
          canRecord
          onRecord={vi.fn()}
          presentActions={[{ id: "preview", label: "Preview", onSelect: vi.fn() }]}
          aiActions={[{ id: "polish", label: "Polish", onSelect: vi.fn() }]}
          exportActions={[{ id: "word", label: "Word", onSelect: vi.fn() }]}
          locked={false}
          onToggleLock={vi.fn()}
          lockLabel="Lock sketch"
          unlockLabel="Unlock sketch"
        />
      </div>,
    );

    expect(observer.observe).toHaveBeenCalled();

    observer.resize(700);
    expect(screen.getByRole("button", { name: /more document actions/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /present/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ai actions/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /export actions/i })).not.toBeInTheDocument();

    observer.resize(800);
    expect(screen.queryByRole("button", { name: /more document actions/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /present/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ai actions/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /export actions/i })).toBeInTheDocument();
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

    const recordButton = screen.getByRole("button", { name: /record/i });
    const presentButton = screen.getByRole("button", { name: /present/i });

    expect(recordButton).toBeDisabled();
    expect(presentButton).toBeDisabled();

    fireEvent.click(recordButton);
    fireEvent.click(presentButton);

    expect(onRecord).not.toHaveBeenCalled();
    expect(onDisabledAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("menuitem", { name: /preview/i })).not.toBeInTheDocument();
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

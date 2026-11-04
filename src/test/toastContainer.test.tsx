import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn(() => Promise.resolve()) }));

import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { ToastContainer } from "../components/ToastContainer";
import { useToastStore } from "../stores/toastStore";

afterEach(() => {
  cleanup();
  act(() => useToastStore.setState({ toasts: [] }));
});

describe("ToastContainer actions", () => {
  it("dismisses the toast and runs an in-app action like Undo", () => {
    const undo = vi.fn();
    act(() => useToastStore.getState().show("Discarded 2 changes", 10_000, "info", { label: "Undo", onSelect: undo }));
    render(<ToastContainer />);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(shellOpen).not.toHaveBeenCalled();
  });

  it("opens URL links in the browser", () => {
    act(() => useToastStore.getState().show("Sent", 5000, "success", { label: "Open", url: "https://example.com" }));
    render(<ToastContainer />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(shellOpen).toHaveBeenCalledWith("https://example.com");
  });
});

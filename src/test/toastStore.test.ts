import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "../stores/toastStore";

describe("toastStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("replaces an identical visible toast instead of stacking it", () => {
    const { show } = useToastStore.getState();
    show("Pending", 1000, "warning");
    vi.advanceTimersByTime(600);
    show("Pending", 1000, "warning");
    expect(useToastStore.getState().toasts).toHaveLength(1);

    vi.advanceTimersByTime(600);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("keeps toasts that differ in message or type", () => {
    const { show } = useToastStore.getState();
    show("Pending", 1000, "warning");
    show("Pending", 1000, "info");
    show("Other", 1000, "warning");
    expect(useToastStore.getState().toasts).toHaveLength(3);
  });
});

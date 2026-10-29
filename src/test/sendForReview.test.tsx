import { fireEvent, render, screen } from "@testing-library/react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SendForReviewDialog } from "../components/SendForReviewDialog";
import { ToastContainer } from "../components/ToastContainer";
import { useAppStore } from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn().mockResolvedValue(undefined),
}));

describe("Send for review UI", () => {
  afterEach(() => {
    useAppStore.setState({
      sendForReviewPrompt: null,
      sendForReview: useAppStore.getInitialState().sendForReview,
    });
    useToastStore.setState({ toasts: [] });
    vi.mocked(shellOpen).mockClear();
  });

  it("prefills the pull request title and sends the edited title and description", () => {
    const sendForReview = vi.fn(async () => {});
    useAppStore.setState({ sendForReviewPrompt: { defaultTitle: "Tighten intro" }, sendForReview });

    render(<SendForReviewDialog />);

    const title = screen.getByLabelText("Pull request title") as HTMLInputElement;
    expect(title.value).toBe("Tighten intro");
    fireEvent.change(title, { target: { value: "Launch demo" } });
    fireEvent.change(screen.getByLabelText("Description (optional)"), { target: { value: "Please review" } });
    fireEvent.click(screen.getByRole("button", { name: "Send for review" }));

    expect(sendForReview).toHaveBeenCalledWith("Launch demo", "Please review");
  });

  it("cancels without sending", () => {
    const sendForReview = vi.fn(async () => {});
    useAppStore.setState({ sendForReviewPrompt: { defaultTitle: "Tighten intro" }, sendForReview });

    render(<SendForReviewDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(sendForReview).not.toHaveBeenCalled();
    expect(useAppStore.getState().sendForReviewPrompt).toBeNull();
  });

  it("opens a toast link in the system browser", () => {
    useToastStore.getState().show("Pull request #12 opened for review.", 10000, "success", {
      label: "Open",
      url: "https://github.com/contoso/app/pull/12",
    });

    render(<ToastContainer />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(shellOpen).toHaveBeenCalledWith("https://github.com/contoso/app/pull/12");
  });
});

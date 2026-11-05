import { fireEvent, render, screen } from "@testing-library/react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SendForReviewDialog } from "../components/SendForReviewDialog";
import { ToastContainer } from "../components/ToastContainer";
import { useSyncStore } from "../stores/syncStore";
import { useToastStore } from "../stores/toastStore";

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn().mockResolvedValue(undefined),
}));

describe("Send for review UI", () => {
  afterEach(() => {
    useSyncStore.setState({
      sendForReviewPrompt: null,
      sendForReview: useSyncStore.getInitialState().sendForReview,
    });
    useToastStore.setState({ toasts: [] });
    vi.mocked(shellOpen).mockClear();
  });

  it("prefills the pull request title and sends the edited title and description", () => {
    const sendForReview = vi.fn(async () => true);
    useSyncStore.setState({ sendForReviewPrompt: { defaultTitle: "Tighten intro" }, sendForReview });

    render(<SendForReviewDialog />);

    const title = screen.getByLabelText("Pull request title") as HTMLInputElement;
    expect(title.value).toBe("Tighten intro");
    fireEvent.change(title, { target: { value: "Launch demo" } });
    fireEvent.change(screen.getByLabelText("Description (optional)"), { target: { value: "Please review" } });
    fireEvent.click(screen.getByRole("button", { name: "Send for review" }));

    expect(sendForReview).toHaveBeenCalledWith("Launch demo", "Please review");
  });

  it("prefills the description with the version comment", () => {
    const sendForReview = vi.fn(async () => true);
    useSyncStore.setState({ sendForReviewPrompt: { defaultTitle: "Tighten intro", defaultBody: "Cut the second demo." }, sendForReview });

    render(<SendForReviewDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Send for review" }));

    expect(sendForReview).toHaveBeenCalledWith("Tighten intro", "Cut the second demo.");
  });

  it("cancels without sending", () => {
    const sendForReview = vi.fn(async () => true);
    useSyncStore.setState({ sendForReviewPrompt: { defaultTitle: "Tighten intro" }, sendForReview });

    render(<SendForReviewDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(sendForReview).not.toHaveBeenCalled();
    expect(useSyncStore.getState().sendForReviewPrompt).toBeNull();
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

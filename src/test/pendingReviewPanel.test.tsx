import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/tauri", () => ({
  invoke: vi.fn(),
  convertFileSrc: (p: string) => p,
  Channel: class {},
  listen: vi.fn().mockResolvedValue(() => {}),
  once: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
  emitTo: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "../services/tauri";
import { PendingReviewPanel } from "../components/PendingReviewPanel";

const mockedInvoke = vi.mocked(invoke);

const REVIEW = {
  run_id: "run-1",
  actor: "Writer",
  started_at: "2026-01-01T00:00:00Z",
  documents: [
    { doc: "intro.sk", through_seq: 4, writes: 2, created: false, last_at: "2026-01-01T00:01:00Z" },
    { doc: "notes.md", through_seq: 5, writes: 1, created: true, last_at: "2026-01-01T00:02:00Z" },
  ],
};

afterEach(() => mockedInvoke.mockReset());

describe("PendingReviewPanel", () => {
  it("renders nothing when no run is pending", async () => {
    mockedInvoke.mockResolvedValue([]);
    const { container } = render(<PendingReviewPanel />);
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("list_pending_reviews"));
    expect(container).toBeEmptyDOMElement();
  });

  it("lists pending documents under a labelled section with a count", async () => {
    mockedInvoke.mockResolvedValue([REVIEW]);
    render(<PendingReviewPanel />);
    const region = await screen.findByRole("region", { name: "Pending review 2 documents" });
    expect(region).toHaveTextContent("Writer · 2 changes");
    expect(region).toHaveTextContent("Writer · 1 change · new");
  });

  it("keeps one document through the review IPC", async () => {
    mockedInvoke.mockImplementation(async (command: string) =>
      command === "list_pending_reviews" ? [REVIEW] : undefined,
    );
    render(<PendingReviewPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Keep changes to intro.sk" }));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("keep_run_document", {
        runId: "run-1",
        doc: "intro.sk",
        throughSeq: 4,
      }),
    );
  });
});

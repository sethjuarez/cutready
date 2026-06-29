import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockPreviewDraftlineVersionFile = vi.hoisted(() => vi.fn());
const mockPreviewDraftlineWorkspaceFile = vi.hoisted(() => vi.fn());
const mockPreviewDraftlineWorkspaceDiffFile = vi.hoisted(() => vi.fn());

vi.mock("../services/draftlineVersioning", () => ({
  previewDraftlineVersionFile: (...args: unknown[]) => mockPreviewDraftlineVersionFile(...args),
  previewDraftlineWorkspaceFile: (...args: unknown[]) => mockPreviewDraftlineWorkspaceFile(...args),
  previewDraftlineWorkspaceDiffFile: (...args: unknown[]) => mockPreviewDraftlineWorkspaceDiffFile(...args),
}));

import { DiffViewer, snapshotDiffTabPath } from "../components/DiffViewer";

describe("DiffViewer", () => {
  afterEach(() => {
    mockPreviewDraftlineVersionFile.mockReset();
    mockPreviewDraftlineWorkspaceFile.mockReset();
    mockPreviewDraftlineWorkspaceDiffFile.mockReset();
  });

  it("shows a structured removal when a snapshot restore would delete a sketch", async () => {
    mockPreviewDraftlineVersionFile.mockResolvedValue(null);
    mockPreviewDraftlineWorkspaceFile.mockResolvedValue({
      path: "developer-demo/sketch.sk",
      content: JSON.stringify({ title: "Current sketch", rows: [] }),
      isBinary: false,
    });

    render(
      <DiffViewer
        filePath={snapshotDiffTabPath("09d901764fa67bb691f4f80b9c6993a4dfe5faa2", "developer-demo/sketch.sk")}
      />,
    );

    await waitFor(() => expect(screen.queryByText("Loading diff…")).not.toBeInTheDocument());

    expect(screen.queryByText("Could not parse current version")).not.toBeInTheDocument();
    expect(screen.getByText("(root)")).toBeInTheDocument();
    expect(screen.getByText("removed")).toBeInTheDocument();
    expect(screen.getByText("Snapshot restore")).toBeInTheDocument();
  });

  it("distinguishes a present binary file from a missing side", async () => {
    mockPreviewDraftlineWorkspaceDiffFile.mockResolvedValue({
      path: "screenshots/demo.png",
      headContent: null,
      workingContent: null,
      headPresent: true,
      workingPresent: true,
      isBinary: true,
    });

    render(<DiffViewer filePath="screenshots/demo.png" />);

    await waitFor(() => expect(screen.queryByText("Loading diff…")).not.toBeInTheDocument());

    expect(screen.getByText("Binary file preview")).toBeInTheDocument();
    expect(screen.getAllByText("Binary file present")).toHaveLength(2);
    expect(screen.queryByText("File missing")).not.toBeInTheDocument();
  });
});

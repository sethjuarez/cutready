import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UnsavedWorkspaceDialog } from "../components/UnsavedWorkspaceDialog";
import { useVersioningStore } from "../stores/versioningStore";

const originalRefresh = useVersioningStore.getState().refreshChangedFiles;

describe("UnsavedWorkspaceDialog", () => {
  afterEach(() => {
    useVersioningStore.setState({ changedFiles: [], refreshChangedFiles: originalRefresh, hasStash: false });
  });

  function renderDialog(onShelveAndContinue?: () => void) {
    useVersioningStore.setState({
      changedFiles: [
        { path: "intro.sk", status: "modified", additions: 1, deletions: 0 },
        { path: "notes/plan.md", status: "added", additions: 3, deletions: 0 },
      ],
      refreshChangedFiles: vi.fn().mockResolvedValue(undefined),
    });
    render(
      <UnsavedWorkspaceDialog
        open
        targetLabel="feature"
        onSaveFirst={vi.fn()}
        onDiscardAndContinue={vi.fn()}
        onShelveAndContinue={onShelveAndContinue}
        onCancel={vi.fn()}
      />,
    );
  }

  it("lists the files that would be discarded", () => {
    renderDialog();
    const list = screen.getByTestId("workspace-changes-list");
    expect(list).toHaveTextContent("intro.sk");
    expect(list).toHaveTextContent("notes/plan.md");
    expect(useVersioningStore.getState().refreshChangedFiles).toHaveBeenCalled();
  });

  it("offers Shelve only when a handler is given", () => {
    const onShelve = vi.fn();
    renderDialog(onShelve);
    fireEvent.click(screen.getByText("Shelve and continue"));
    expect(onShelve).toHaveBeenCalledOnce();
  });

  it("hides Shelve when no handler is given", () => {
    renderDialog();
    expect(screen.queryByText("Shelve and continue")).toBeNull();
  });
});

describe("stashChanges", () => {
  afterEach(() => useVersioningStore.setState({ hasStash: false }));

  it("refuses to overwrite an existing shelf", async () => {
    useVersioningStore.setState({ hasStash: true });
    await expect(useVersioningStore.getState().stashChanges()).resolves.toBe(false);
  });
});

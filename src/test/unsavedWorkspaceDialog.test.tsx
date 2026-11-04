import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UnsavedWorkspaceDialog } from "../components/UnsavedWorkspaceDialog";
import { useVersioningStore } from "../stores/versioningStore";

const originalRefresh = useVersioningStore.getState().refreshChangedFiles;

describe("UnsavedWorkspaceDialog", () => {
  afterEach(() => {
    useVersioningStore.setState({ changedFiles: [], refreshChangedFiles: originalRefresh, hasStash: false });
  });

  function renderDialog(onSetAside?: () => void) {
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
        onSetAside={onSetAside}
        onCancel={vi.fn()}
      />,
    );
  }

  it("lists the unsaved files", () => {
    renderDialog();
    const list = screen.getByTestId("workspace-changes-list");
    expect(list).toHaveTextContent("intro.sk");
    expect(list).toHaveTextContent("notes/plan.md");
    expect(useVersioningStore.getState().refreshChangedFiles).toHaveBeenCalled();
  });

  it("offers Set aside only when a handler is given", () => {
    const onShelve = vi.fn();
    renderDialog(onShelve);
    fireEvent.click(screen.getByText("Set aside & switch"));
    expect(onShelve).toHaveBeenCalledOnce();
  });

  it("never offers to discard", () => {
    renderDialog(vi.fn());
    expect(screen.queryByText(/discard/i)).toBeNull();
    expect(screen.getByText("Save version & continue")).toBeInTheDocument();
  });

  it("hides Set aside when no handler is given", () => {
    renderDialog();
    expect(screen.queryByText("Set aside & switch")).toBeNull();
  });
});

describe("stashChanges", () => {
  afterEach(() => useVersioningStore.setState({ hasStash: false }));

  it("refuses to overwrite an existing shelf", async () => {
    useVersioningStore.setState({ hasStash: true });
    await expect(useVersioningStore.getState().stashChanges()).resolves.toBe(false);
  });
});

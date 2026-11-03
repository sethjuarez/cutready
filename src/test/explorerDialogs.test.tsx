import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { DeleteAssetDialog, TransferConflictDialog, type PendingDelete } from "../components/docTree/ExplorerDialogs";
import type { ProjectEntry } from "../types/project";

const flushFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

describe("explorer dialogs", () => {
  it("delete moves focus to Cancel and returns it to the opener on close", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const pending: PendingDelete = { type: "note", path: "a.md", title: "A", usedBy: ["Board"] };
    const onConfirm = vi.fn();
    const { rerender } = render(<DeleteAssetDialog pending={pending} onCancel={() => {}} onConfirm={onConfirm} />);
    await flushFrame();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("delete-asset-used-by").textContent).toContain("Board");
    screen.getByTestId("delete-asset-confirm").click();
    expect(onConfirm).toHaveBeenCalledWith(pending);
    rerender(<DeleteAssetDialog pending={null} onCancel={() => {}} onConfirm={onConfirm} />);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("conflict preselects the suggested name and submits the renamed path", async () => {
    const onSubmit = vi.fn();
    const conflict = {
      action: "copy" as const,
      type: "note" as const,
      sourcePath: "notes/plan.md",
      sourceTitle: "Plan",
      destProject: { name: "Other", path: "other" } as ProjectEntry,
      ext: ".md",
      stem: "plan",
    };
    render(<TransferConflictDialog conflict={conflict} onCancel={() => {}} onSubmit={onSubmit} />);
    await flushFrame();
    const input = screen.getByRole("textbox", { name: "New file name" }) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("plan");
    screen.getByRole("button", { name: "Copy As" }).click();
    expect(onSubmit).toHaveBeenCalledWith(conflict, "notes/plan.md");
  });
});
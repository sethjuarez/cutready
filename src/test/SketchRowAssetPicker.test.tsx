import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("../components/ProjectImage", () => ({
  ProjectImage: ({
    relativePath,
    alt,
    className,
  }: {
    relativePath: string;
    alt?: string;
    className?: string;
  }) => (
    <img
      src={`data:image/mock,${relativePath}`}
      alt={alt}
      className={className}
      data-relative-path={relativePath}
    />
  ),
}));

vi.mock("../components/VisualCell", () => ({
  default: ({
    visualPath,
    mode,
    className,
  }: {
    visualPath: string;
    mode: "thumbnail" | "full";
    className?: string;
  }) => (
    <div className={className} data-testid={`visual-${mode}`} data-visual-path={visualPath}>
      {visualPath}
    </div>
  ),
}));

import { SketchRowAssetPicker } from "../components/SketchForm";

describe("SketchRowAssetPicker", () => {
  const assets = [
    { path: "screenshots/first.png", size: 1024, assetType: "screenshot" },
    { path: "screenshots/second.png", size: 2048, assetType: "screenshot" },
    { path: ".cutready/visuals/diagram.json", size: 512, assetType: "visual" },
  ];

  it("renders a large responsive dialog with preview and thumbnail selection", async () => {
    const user = userEvent.setup();
    const onSelectedPathChange = vi.fn();
    const onInsert = vi.fn();

    const { rerender } = render(
      <SketchRowAssetPicker
        assets={assets}
        projectRoot="C:\\demo-project"
        selectedPath={assets[0].path}
        onSelectedPathChange={onSelectedPathChange}
        onInsert={onInsert}
        onBrowse={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Pick an image or visual" });
    expect(dialog).toHaveStyle({
      width: "min(1180px, calc(100vw - 32px))",
    });
    expect(screen.getByText("Previewing selected image")).toBeInTheDocument();
    expect(screen.getByText("screenshots/first.png")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Preview second.png" }));
    expect(onSelectedPathChange).toHaveBeenCalledWith("screenshots/second.png");

    rerender(
      <SketchRowAssetPicker
        assets={assets}
        projectRoot="C:\\demo-project"
        selectedPath={assets[1].path}
        onSelectedPathChange={onSelectedPathChange}
        onInsert={onInsert}
        onBrowse={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("screenshots/second.png")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Insert" }));
    expect(onInsert).toHaveBeenCalledWith(assets[1]);
  });

  it("supports visual previews, browse, double-click insert, and Escape cancel", async () => {
    const user = userEvent.setup();
    const onBrowse = vi.fn();
    const onCancel = vi.fn();
    const onInsert = vi.fn();

    render(
      <SketchRowAssetPicker
        assets={assets}
        projectRoot="C:\\demo-project"
        selectedPath={assets[2].path}
        onSelectedPathChange={vi.fn()}
        onInsert={onInsert}
        onBrowse={onBrowse}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText("Previewing selected visual")).toBeInTheDocument();
    expect(screen.getByTestId("visual-full")).toHaveAttribute("data-visual-path", ".cutready/visuals/diagram.json");

    await user.click(screen.getByRole("button", { name: /browse files/i }));
    expect(onBrowse).toHaveBeenCalledTimes(1);

    await user.dblClick(screen.getByRole("button", { name: "Preview first.png" }));
    expect(onInsert).toHaveBeenCalledWith(assets[0]);

    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

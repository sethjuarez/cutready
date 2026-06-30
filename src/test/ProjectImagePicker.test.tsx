import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectImagePicker } from "../components/ProjectImagePicker";
import { useAppStore, type AssetInfo } from "../stores/appStore";

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

describe("ProjectImagePicker", () => {
  const assets: AssetInfo[] = [
    {
      path: "screenshots/first.png",
      size: 1024,
      assetType: "screenshot",
      referencedBy: [],
      modifiedAt: 1,
    },
    {
      path: "screenshots/second.png",
      size: 2048,
      assetType: "screenshot",
      referencedBy: [],
      modifiedAt: 2,
    },
    {
      path: ".cutready/visuals/diagram.json",
      size: 512,
      assetType: "visual",
      referencedBy: [],
      modifiedAt: 3,
    },
  ];

  beforeEach(() => {
    useAppStore.setState({
      assets,
      currentProject: {
        root: "C:\\demo-project",
        repo_root: "C:\\demo-project",
        name: "demo-project",
      },
      loadAssets: vi.fn(async () => undefined),
    });
  });

  it("renders a larger responsive dialog with a full-size preview pane", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onCancel = vi.fn();

    render(<ProjectImagePicker onSelect={onSelect} onCancel={onCancel} />);

    const dialog = screen.getByRole("dialog", { name: "Choose project image" });
    expect(dialog).toHaveStyle({
      width: "min(1180px, calc(100vw - 32px))",
      maxHeight: "calc(100vh - 32px)",
    });

    expect(screen.getByText("Previewing first match")).toBeInTheDocument();
    expect(screen.getByText("screenshots/first.png")).toBeInTheDocument();
    expect(screen.queryByText(".cutready/visuals/diagram.json")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /second\.png/i }));

    expect(screen.getByText("screenshots/second.png")).toBeInTheDocument();
    expect(screen.queryByText("Previewing first match")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Insert" }));
    expect(onSelect).toHaveBeenCalledWith(assets[1]);
  });

  it("keeps Escape and double-click selection behavior", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onCancel = vi.fn();

    const { rerender } = render(<ProjectImagePicker onSelect={onSelect} onCancel={onCancel} />);

    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);

    rerender(<ProjectImagePicker onSelect={onSelect} onCancel={onCancel} />);
    await user.dblClick(screen.getByRole("button", { name: /first\.png/i }));

    expect(onSelect).toHaveBeenCalledWith(assets[0]);
  });
});

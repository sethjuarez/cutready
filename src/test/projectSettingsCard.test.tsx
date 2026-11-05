import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  readProjectSettings: vi.fn(),
  saveProjectSettings: vi.fn(),
}));
vi.mock("../ipc/workspace", () => ({ workspaceIpc: ipc }));

import { ProjectSettingsCard } from "../components/settings/ProjectSettingsCard";
import { useAppStore } from "../stores/appStore";
import { useProjectSettingsStore } from "../stores/projectSettingsStore";

const root = "D:\\alaska\\cutready";

describe("ProjectSettingsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectSettingsStore.getState().clear();
    useAppStore.setState({ currentProject: { root, name: "cutready", repo_root: "D:\\alaska", hybrid: true } });
    ipc.readProjectSettings.mockResolvedValue({ id: "p1", base_branch: "main", commit_template: null });
    ipc.saveProjectSettings.mockImplementation(async (_root, base_branch, commit_template) => ({ id: "p1", base_branch, commit_template }));
  });

  it("is hidden outside projects that live in a code repository", () => {
    useAppStore.setState({ currentProject: { root: "D:\\demo", name: "demo", repo_root: "D:\\demo", hybrid: false } });
    render(<ProjectSettingsCard />);
    expect(screen.queryByTestId("project-settings-card")).toBeNull();
    expect(ipc.readProjectSettings).not.toHaveBeenCalled();
  });

  it("loads the recorded settings and saves a label template", async () => {
    render(<ProjectSettingsCard />);
    const sendTo = await screen.findByLabelText("Send saves to");
    await waitFor(() => expect(sendTo).toHaveValue("main"));
    const save = screen.getByRole("button", { name: "Save project settings" });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Save label template"), { target: { value: "docs(demo): {subject}" } });
    fireEvent.click(save);

    await screen.findByText("Saved for everyone on this project.");
    expect(ipc.saveProjectSettings).toHaveBeenCalledWith(root, "main", "docs(demo): {subject}");
    expect(useProjectSettingsStore.getState().settings?.commit_template).toBe("docs(demo): {subject}");
  });

  it("blocks a template without {subject}", async () => {
    render(<ProjectSettingsCard />);
    const template = await screen.findByLabelText("Save label template");
    fireEvent.change(template, { target: { value: "docs: " } });
    expect(template).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/exactly once/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save project settings" })).toBeDisabled();
  });

  it("shows a save failure in plain words", async () => {
    ipc.saveProjectSettings.mockRejectedValue({ code: "git_index_locked", message: "locked" });
    render(<ProjectSettingsCard />);
    await waitFor(() => expect(screen.getByLabelText("Send saves to")).toHaveValue("main"));
    fireEvent.change(screen.getByLabelText("Send saves to"), { target: { value: "release" } });
    fireEvent.click(screen.getByRole("button", { name: "Save project settings" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/Git is busy/);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  cloneRepositoryForProject: vi.fn(),
  reserveProjectFolder: vi.fn(),
  cloneFromUrl: vi.fn(),
  lastParentFolder: vi.fn(),
}));
vi.mock("../ipc/workspace", () => ({ workspaceIpc: ipc }));

import { cloneErrorView, repoNameFromUrl, startProjectInRepository } from "../services/repoClone";
import { NewInRepoForm } from "../components/home/NewInRepoForm";
import { CloneWorkspaceForm } from "../components/home/NewWorkspaceForms";
import { AdoptFolderDialog } from "../components/AdoptFolderDialog";
import { useAppStore } from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";
import type { ProjectView } from "../types/project";

const project = (root: string): ProjectView => ({ root, name: "demo", repo_root: root, hybrid: true });

describe("repoClone service", () => {
  it("names the clone after the repository", () => {
    expect(repoNameFromUrl("https://github.com/org/app.git")).toBe("app");
    expect(repoNameFromUrl("git@github.com:org/app.git")).toBe("app");
    expect(repoNameFromUrl("C:\\code\\app\\")).toBe("app");
    expect(repoNameFromUrl("  ")).toBe("repository");
    expect(repoNameFromUrl("..")).toBe("repository");
    expect(repoNameFromUrl("C:\\code\\.")).toBe("repository");
  });

  it("explains failures by code", () => {
    expect(cloneErrorView({ code: "auth_failed", message: "denied" }).kind).toBe("auth");
    expect(cloneErrorView("remote said 401").kind).toBe("auth");
    expect(cloneErrorView({ code: "network_failed", message: "x" }).message).toMatch(/Couldn't reach/);
    expect(cloneErrorView({ code: "destination_not_empty", message: "x", details: { path: "C:\\a" } }).message)
      .toBe('"C:\\a" already has files in it. Choose another location.');
    expect(cloneErrorView({ code: "file_exists", message: "x", details: { path: "/r/src" } }).message)
      .toMatch(/^"\/r\/src" already exists in the repository/);
    expect(cloneErrorView({ code: "invalid_marker", message: "x" }).message).toMatch(/\.draftline/);
    expect(cloneErrorView({ code: "clone_failed", message: "git-lfs filter failed" }).message).toMatch(/Git LFS/);
    expect(cloneErrorView({ code: "clone_failed", message: "boom" })).toEqual({ kind: "generic", message: "boom" });
  });

  it("opens the folder a marked repository already manages", async () => {
    const deps = { reserveFolder: vi.fn(), createProject: vi.fn(), openProject: vi.fn() };
    const result = await startProjectInRepository(deps, { root: "/r", managedFolder: "/r/talk" }, "cutready");
    expect(result).toEqual({ kind: "opened-existing", folder: "/r/talk" });
    expect(deps.openProject).toHaveBeenCalledWith("/r/talk");
    expect(deps.reserveFolder).not.toHaveBeenCalled();
  });

  it("creates a new folder in an unmarked repository", async () => {
    const deps = {
      reserveFolder: vi.fn().mockResolvedValue("/r/cutready"),
      createProject: vi.fn().mockResolvedValue(undefined),
      openProject: vi.fn(),
    };
    const result = await startProjectInRepository(deps, { root: "/r", managedFolder: null }, "cutready");
    expect(deps.reserveFolder).toHaveBeenCalledWith("/r", "cutready");
    expect(deps.createProject).toHaveBeenCalledWith("/r/cutready");
    expect(result).toEqual({ kind: "created", folder: "/r/cutready" });
  });

  it("never creates a project over a folder that already exists", async () => {
    const deps = {
      reserveFolder: vi.fn().mockRejectedValue({ code: "file_exists", message: "taken" }),
      createProject: vi.fn(),
      openProject: vi.fn(),
    };
    await expect(startProjectInRepository(deps, { root: "/r", managedFolder: null }, "src")).rejects.toMatchObject({
      code: "file_exists",
    });
    expect(deps.createProject).not.toHaveBeenCalled();
  });
});

describe("New in existing repo form", () => {
  const createProject = vi.fn();
  const openProject = vi.fn();
  const onClose = vi.fn();
  const chooseFolder = vi.fn().mockResolvedValue("/work");

  beforeEach(() => {
    vi.clearAllMocks();
    chooseFolder.mockResolvedValue("/work");
    createProject.mockImplementation(async (path: string) => useAppStore.setState({ currentProject: project(path) }));
    openProject.mockImplementation(async (path: string) => useAppStore.setState({ currentProject: project(path) }));
    useAppStore.setState({ createProject, openProject, currentProject: null, error: null, adoptionPrompt: null });
  });
  afterEach(() => useToastStore.setState({ toasts: [] }));

  async function fillAndStart(name = "talk") {
    render(<NewInRepoForm chooseFolder={chooseFolder} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "https://github.com/org/app.git" } });
    fireEvent.click(screen.getByRole("button", { name: "Download to" }));
    await screen.findByText("/work/app");
    fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: name } });
    fireEvent.click(screen.getByRole("button", { name: "Download & create" }));
  }

  it("clones the repository and creates the CutReady folder in it", async () => {
    ipc.cloneRepositoryForProject.mockResolvedValue({ root: "/work/app", managedFolder: null });
    ipc.reserveProjectFolder.mockResolvedValue("/work/app/talk");
    await fillAndStart();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(ipc.cloneRepositoryForProject).toHaveBeenCalledWith("https://github.com/org/app.git", "/work/app");
    expect(createProject).toHaveBeenCalledWith("/work/app/talk");
  });

  it("opens the existing project in a marked repository and says so", async () => {
    ipc.cloneRepositoryForProject.mockResolvedValue({ root: "/work/app", managedFolder: "/work/app/demo" });
    await fillAndStart();
    await waitFor(() => expect(openProject).toHaveBeenCalledWith("/work/app/demo"));
    expect(createProject).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts[0]?.message).toMatch(/already has a CutReady project/);
  });

  it("asks for another name without downloading again when the folder exists", async () => {
    ipc.cloneRepositoryForProject.mockResolvedValue({ root: "/work/app", managedFolder: null });
    ipc.reserveProjectFolder
      .mockRejectedValueOnce({ code: "file_exists", message: "taken", details: { path: "/work/app/src" } })
      .mockResolvedValueOnce("/work/app/talk");
    await fillAndStart("src");
    expect(await screen.findByRole("alert")).toHaveTextContent('"/work/app/src" already exists');
    fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: "talk" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(createProject).toHaveBeenCalledWith("/work/app/talk"));
    expect(ipc.cloneRepositoryForProject).toHaveBeenCalledTimes(1);
  });

  it("doesn't report success when the project didn't open", async () => {
    ipc.cloneRepositoryForProject.mockResolvedValue({ root: "/work/app", managedFolder: "/work/app/demo" });
    useAppStore.setState({ currentProject: project("/elsewhere") });
    openProject.mockResolvedValue(undefined);
    await fillAndStart();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't open /work/app/demo");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows the store's error when creating the project fails", async () => {
    ipc.cloneRepositoryForProject.mockResolvedValue({ root: "/work/app", managedFolder: null });
    ipc.reserveProjectFolder.mockResolvedValue("/work/app/talk");
    createProject.mockImplementation(async () => useAppStore.setState({ error: "disk full" }));
    await fillAndStart();
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("offers GitHub sign-in when the clone needs authentication", async () => {
    ipc.cloneRepositoryForProject.mockRejectedValue({ code: "auth_failed", message: "denied" });
    await fillAndStart();
    expect(await screen.findByText("Authentication required")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("Clone form", () => {
  it("opens the folder the clone reports, such as a hybrid repo's CutReady folder", async () => {
    const openProject = vi.fn();
    useAppStore.setState({ openProject });
    ipc.cloneFromUrl.mockResolvedValue("/work/app/cutready");
    render(<CloneWorkspaceForm chooseFolder={vi.fn().mockResolvedValue("/work")} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Workspace URL"), { target: { value: "https://github.com/org/app.git" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose Folder & Clone" }));
    await waitFor(() => expect(openProject).toHaveBeenCalledWith("/work/app/cutready"));
    expect(ipc.cloneFromUrl).toHaveBeenCalledWith("https://github.com/org/app.git", "/work/app");
  });
});

describe("AdoptFolderDialog", () => {
  const prompt = (folder: string, repository: string | null) => ({
    folder,
    suggested: `${folder}/cutready`,
    suggestedExists: false,
    repository,
    movedTo: null,
  });

  it("doesn't offer to manage a whole repository root", () => {
    useAppStore.setState({ adoptionPrompt: prompt("/code/app", "/code/app") } as never);
    render(<AdoptFolderDialog />);
    expect(screen.getByRole("button", { name: "Create cutready/" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /as is/ })).not.toBeInTheDocument();
  });

  it("still offers it for a plain folder", () => {
    useAppStore.setState({ adoptionPrompt: prompt("/notes", null) } as never);
    render(<AdoptFolderDialog />);
    expect(screen.getByRole("button", { name: "Use notes as is" })).toBeInTheDocument();
  });
});

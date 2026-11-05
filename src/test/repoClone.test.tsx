import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  cloneRepositoryForProject: vi.fn(),
  createProjectInRepository: vi.fn(),
  cloneFromUrl: vi.fn(),
  lastParentFolder: vi.fn(),
  inspectRepositoryForProject: vi.fn(),
}));
vi.mock("../ipc/workspace", () => ({ workspaceIpc: ipc }));

import { cloneErrorView, projectFolderName, repoNameFromUrl, startProjectInRepository } from "../services/repoClone";
import { NewInRepoForm } from "../components/home/NewInRepoForm";
import { CloneProgressBar, formatBytes, stagePercent } from "../components/home/CloneProgressBar";
import { CloneWorkspaceForm } from "../components/home/NewWorkspaceForms";
import { AdoptFolderDialog } from "../components/AdoptFolderDialog";
import { useAppStore } from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";
import type { ProjectView } from "../types/project";
import type { RepositoryInspection } from "@draftline/client";
import { repoPreflight } from "../services/repoPreflight";

const project = (root: string): ProjectView => ({ root, name: "demo", repo_root: root, hybrid: true });

const repo = (root: string, project_path: string | null = null, is_partial_clone = false) => ({
  location_kind: "local" as const,
  is_repository: true,
  root,
  project: null,
  current_branch: "main",
  default_branch: "main",
  branches: ["main"],
  remotes: [],
  lfs: { used: false, available: true },
  target_folder: null,
  project_path,
  is_partial_clone,
});

const inspection = (overrides: Partial<RepositoryInspection> = {}): RepositoryInspection => ({
  location_kind: "remote",
  is_repository: true,
  root: null,
  project: null,
  current_branch: null,
  default_branch: "main",
  branches: ["main"],
  remotes: [],
  lfs: { used: null, available: true },
  target_folder: null,
  github: null,
  ...overrides,
});

describe("repoPreflight", () => {
  it("says nothing and offers no choice for a plain one-branch repository", () => {
    expect(repoPreflight(inspection())).toEqual({ notices: [], targets: [] });
  });

  it("offers the default first and leaves out CutReady's own variations", () => {
    const { targets } = repoPreflight(inspection({ branches: ["cutready/demo", "dev", "main"], default_branch: "main" }));
    expect(targets).toEqual(["main", "dev"]);
  });

  it("defaults to where an existing project already sends", () => {
    const project = { folder: "talk", id: "p1", base_branch: "dev", commit_template: null, in_marker: true };
    const result = repoPreflight(inspection({ project, branches: ["dev", "main"] }));
    expect(result.targets[0]).toBe("dev");
    expect(result.notices[0]).toMatchObject({ tone: "info", message: expect.stringContaining('"talk"') });
  });

  it("warns about missing Git LFS and an account that can't send", () => {
    const github = {
      repository: { owner: "contoso", repo: "app" },
      default_branch: "main",
      can_push: false,
      private: false,
      fork_parent: null,
    };
    const { notices } = repoPreflight(inspection({ lfs: { used: true, available: false }, github }));
    expect(notices.map((n) => n.tone)).toEqual(["warning", "warning"]);
    expect(notices[1].message).toMatch(/contoso\/app.*fork/);
  });
});

describe("repoClone service", () => {
  it("names the clone after the repository", () => {
    expect(repoNameFromUrl("https://github.com/org/app.git")).toBe("app");
    expect(repoNameFromUrl("git@github.com:org/app.git")).toBe("app");
    expect(repoNameFromUrl("C:\\code\\app\\")).toBe("app");
    expect(repoNameFromUrl("  ")).toBe("repository");
    expect(repoNameFromUrl("..")).toBe("repository");
    expect(repoNameFromUrl("C:\\code\\.")).toBe("repository");
  });

  it("previews the folder Draftline will create", () => {
    expect(projectFolderName("  Launch Demo! ")).toBe("launch-demo");
    expect(projectFolderName("CON")).toBe("con-project");
    expect(projectFolderName("é")).toBe("");
    expect(projectFolderName(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
  });

  it("explains failures by code", () => {
    expect(cloneErrorView({ code: "auth_failed", message: "denied" }).kind).toBe("auth");
    expect(cloneErrorView({ code: "github_unauthorized", message: "x" }).kind).toBe("auth");
    expect(cloneErrorView("remote said 401").kind).toBe("auth");
    expect(cloneErrorView({ code: "network_failed", message: "x" }).message).toMatch(/Couldn't reach/);
    expect(cloneErrorView({ code: "remote_operation_timed_out", message: "x" }).message).toMatch(/stopped answering/);
    expect(cloneErrorView({ code: "variation_not_found", message: "x" }).message).toMatch(/branch doesn't exist/);
    expect(cloneErrorView({ code: "folder_not_empty", message: "x", details: { path: "C:\\a" } }).message)
      .toBe('"C:\\a" already has files in it. Choose another location.');
    expect(cloneErrorView({ code: "folder_not_empty", message: "x", details: { path: "/r/src" } }, "create").message)
      .toMatch(/^"\/r\/src" already exists in the repository/);
    expect(cloneErrorView({ code: "folder_is_elsewhere", message: "x" }).message).toMatch(/already has a CutReady project/);
    expect(cloneErrorView({ code: "invalid_folder_marker", message: "x" }).message).toMatch(/\.draftline/);
    expect(cloneErrorView({ code: "newer_folder_marker", message: "x" }).message).toMatch(/newer CutReady/);
    expect(cloneErrorView({ code: "git_filter_failed", message: "x" }).message).toMatch(/Git LFS/);
    expect(cloneErrorView({ code: "clone_failed", message: "git-lfs filter failed" }).message).toMatch(/Git LFS/);
    expect(cloneErrorView({ code: "clone_failed", message: "boom" })).toEqual({ kind: "generic", message: "boom" });
  });

  const deps = () => ({ initProject: vi.fn(), openProject: vi.fn(), openCreated: vi.fn() });

  it("opens the project a repository already has", async () => {
    const d = deps();
    const result = await startProjectInRepository(d, repo("/r", "/r/talk"), "cutready");
    expect(result).toEqual({ kind: "opened-existing", folder: "/r/talk" });
    expect(d.openProject).toHaveBeenCalledWith("/r/talk");
    expect(d.initProject).not.toHaveBeenCalled();
  });

  it("creates the project folder in a repository without one and opens the folder Draftline made", async () => {
    const d = deps();
    d.initProject.mockResolvedValue("/r/launch-demo");
    const result = await startProjectInRepository(d, repo("/r"), "Launch Demo");
    expect(d.initProject).toHaveBeenCalledWith("/r", "Launch Demo");
    expect(d.openCreated).toHaveBeenCalledWith("/r/launch-demo");
    expect(result).toEqual({ kind: "created", folder: "/r/launch-demo" });
  });

  it("marks a failed init as a create-step error and opens nothing", async () => {
    const d = deps();
    d.initProject.mockRejectedValue({ code: "folder_not_empty", message: "taken" });
    await expect(startProjectInRepository(d, repo("/r"), "src")).rejects.toMatchObject({
      phase: "create",
      error: { code: "folder_not_empty" },
    });
    expect(d.openCreated).not.toHaveBeenCalled();
  });
});

describe("CloneProgressBar", () => {
  const event = (stage: "receiving" | "resolving" | "checking_out", completed: number, total: number, received_bytes = 0) =>
    ({ progress_id: "p", workspace_path: "/w", stage, completed, total, received_bytes });

  it("shows the stage, percent and bytes", () => {
    render(<CloneProgressBar progress={event("receiving", 25, 100, 3 * 1024 * 1024)} />);
    expect(screen.getByText("Downloading… · 3.0 MB")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  });

  it("has no percent while the size is unknown", () => {
    expect(stagePercent(event("resolving", 4, 0))).toBeNull();
    expect(formatBytes(512)).toBe("512 B");
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
    ipc.inspectRepositoryForProject.mockResolvedValue(inspection());
    createProject.mockImplementation(async (path: string) => useAppStore.setState({ currentProject: project(path) }));
    openProject.mockImplementation(async (path: string) => useAppStore.setState({ currentProject: project(path) }));
    useAppStore.setState({ createProject, openProject, currentProject: null, error: null, adoptionPrompt: null });
  });
  afterEach(() => useToastStore.setState({ toasts: [] }));

  async function fillAndStart(name = "talk", { blobless = false } = {}) {
    render(<NewInRepoForm chooseFolder={chooseFolder} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "https://github.com/org/app.git" } });
    fireEvent.click(screen.getByRole("button", { name: "Download to" }));
    await screen.findByText("/work/app");
    fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: name } });
    if (blobless) fireEvent.click(screen.getByRole("checkbox", { name: /Skip old file versions/ }));
    fireEvent.click(screen.getByRole("button", { name: "Download & create" }));
  }

  const inited = (workspace_path: string) => ({ workspace_path, settings: {}, diagnostics: {} });

  it("clones the repository and creates the CutReady folder in it", async () => {
    ipc.cloneRepositoryForProject.mockResolvedValue(repo("/work/app"));
    ipc.createProjectInRepository.mockResolvedValue(inited("/work/app/talk"));
    await fillAndStart();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(ipc.cloneRepositoryForProject).toHaveBeenCalledWith(
      { url: "https://github.com/org/app.git", dest: "/work/app", blobless: false },
      expect.any(Function),
    );
    expect(ipc.createProjectInRepository).toHaveBeenCalledWith("/work/app", "talk", null);
    expect(createProject).toHaveBeenCalledWith("/work/app/talk");
  });

  it("checks the repository first and records where the project sends its saves", async () => {
    ipc.inspectRepositoryForProject.mockResolvedValue(inspection({ branches: ["dev", "main"], lfs: { used: true, available: false } }));
    ipc.cloneRepositoryForProject.mockResolvedValue(repo("/work/app"));
    ipc.createProjectInRepository.mockResolvedValue(inited("/work/app/talk"));
    render(<NewInRepoForm chooseFolder={chooseFolder} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "https://github.com/org/app.git" } });
    const sendTo = await screen.findByLabelText("Send saves to", undefined, { timeout: 3000 });
    expect(ipc.inspectRepositoryForProject).toHaveBeenCalledWith("https://github.com/org/app.git");
    expect(screen.getByText(/uses Git LFS/)).toBeTruthy();
    fireEvent.change(sendTo, { target: { value: "dev" } });
    fireEvent.click(screen.getByRole("button", { name: "Download to" }));
    await screen.findByText("/work/app");
    fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: "talk" } });
    fireEvent.click(screen.getByRole("button", { name: "Download & create" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(ipc.createProjectInRepository).toHaveBeenCalledWith("/work/app", "talk", "dev");
  });

  it("shows download progress while cloning", async () => {
    let finish: (value: unknown) => void = () => {};
    ipc.cloneRepositoryForProject.mockImplementation((_req, onProgress) => {
      onProgress({ progress_id: "p", workspace_path: "/work/app", stage: "receiving", completed: 1, total: 2, received_bytes: 0 });
      return new Promise((resolve) => (finish = resolve));
    });
    await fillAndStart();
    expect(await screen.findByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    finish(repo("/work/app", "/work/app/demo"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("asks for a blobless clone and says when the server sent everything anyway", async () => {
    ipc.cloneRepositoryForProject.mockResolvedValue(repo("/work/app", "/work/app/demo", false));
    await fillAndStart("talk", { blobless: true });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(ipc.cloneRepositoryForProject.mock.calls[0][0]).toMatchObject({ blobless: true });
    expect(useToastStore.getState().toasts.map((t) => t.message).join(" ")).toMatch(/full clone instead/);
  });

  it("opens the existing project in a marked repository and says so", async () => {
    ipc.cloneRepositoryForProject.mockResolvedValue(repo("/work/app", "/work/app/demo"));
    await fillAndStart();
    await waitFor(() => expect(openProject).toHaveBeenCalledWith("/work/app/demo"));
    expect(ipc.createProjectInRepository).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts[0]?.message).toMatch(/already has a CutReady project/);
  });

  it("asks for another name without downloading again when the folder exists", async () => {
    ipc.cloneRepositoryForProject.mockResolvedValue(repo("/work/app"));
    ipc.createProjectInRepository
      .mockRejectedValueOnce({ code: "folder_not_empty", message: "taken", details: { path: "/work/app/src" } })
      .mockResolvedValueOnce(inited("/work/app/talk"));
    await fillAndStart("src");
    expect(await screen.findByRole("alert")).toHaveTextContent('"/work/app/src" already exists in the repository');
    fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: "talk" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(createProject).toHaveBeenCalledWith("/work/app/talk"));
    expect(ipc.cloneRepositoryForProject).toHaveBeenCalledTimes(1);
  });

  it("reopens the folder it made, instead of making another, when opening failed", async () => {
    ipc.cloneRepositoryForProject.mockResolvedValue(repo("/work/app"));
    ipc.createProjectInRepository.mockResolvedValue(inited("/work/app/talk"));
    createProject.mockImplementationOnce(async () => useAppStore.setState({ error: "disk full" }));
    await fillAndStart();
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Workspace name")).toBeDisabled();
    useAppStore.setState({ error: null });
    fireEvent.click(screen.getByRole("button", { name: "Retry opening" }));
    await waitFor(() => expect(openProject).toHaveBeenCalledWith("/work/app/talk"));
    expect(ipc.createProjectInRepository).toHaveBeenCalledTimes(1);
  });

  it("doesn't report success when the project didn't open", async () => {
    ipc.cloneRepositoryForProject.mockResolvedValue(repo("/work/app", "/work/app/demo"));
    useAppStore.setState({ currentProject: project("/elsewhere") });
    openProject.mockResolvedValue(undefined);
    await fillAndStart();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't open /work/app/demo");
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

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  Channel: class {},
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  emitTo: vi.fn(),
  listen: vi.fn(() => Promise.resolve(() => undefined)),
  once: vi.fn(() => Promise.resolve(() => undefined)),
}));

import { ProjectSwitcher } from "../components/ProjectSwitcher";
import { useAppStore } from "../stores/appStore";
import { useVersioningStore } from "../stores/versioningStore";

const project = {
  root: "D:\\workspace\\alpha",
  repo_root: "D:\\workspace",
  name: "Alpha",
};

const projects = [
  { path: "alpha", name: "Alpha" },
  { path: "beta", name: "Beta" },
];

const originalSwitchProject = useAppStore.getState().switchProject;
const originalDiscardChanges = useVersioningStore.getState().discardChanges;
const originalLoadProjects = useAppStore.getState().loadProjects;
const originalDeleteProjectFromRepo = useAppStore.getState().deleteProjectFromRepo;
const mockSwitchProject = vi.fn(() => Promise.resolve(true));
const mockDiscardChanges = vi.fn(() => Promise.resolve());
const mockDeleteProjectFromRepo = vi.fn(() => Promise.resolve());

describe("ProjectSwitcher safety gates", () => {
  afterEach(() => {
    mockSwitchProject.mockClear();
    mockDiscardChanges.mockClear();
    mockInvoke.mockReset();
    act(() => {
      useAppStore.setState({
        switchProject: originalSwitchProject,
        loadProjects: originalLoadProjects,
        deleteProjectFromRepo: originalDeleteProjectFromRepo,
        currentProject: null,
        projects: [],
        isMultiProject: false,
        loading: false,
      });
      useVersioningStore.setState({
        discardChanges: originalDiscardChanges,
        isDirty: false,
        isMerging: false,
      });
    });
  });

  it("switches projects without prompting when workspace content is dirty", async () => {
    act(() => {
      useAppStore.setState({
        switchProject: mockSwitchProject,
        loadProjects: () => Promise.resolve(),
        currentProject: project,
        projects,
        isMultiProject: true,
      });
      useVersioningStore.setState({
        discardChanges: mockDiscardChanges,
        isDirty: true,
      });
    });

    render(<ProjectSwitcher variant="title" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
    });
    const betaButton = await screen.findByRole("button", { name: "Beta" });
    act(() => {
      fireEvent.click(betaButton);
    });

    expect(mockSwitchProject).toHaveBeenCalledWith("beta");
    expect(screen.queryByText("Save changes before continuing?")).not.toBeInTheDocument();
  });

  it("switches away from the active project before deleting it", async () => {
    mockSwitchProject.mockImplementationOnce(async () => {
      useAppStore.setState({ currentProject: { ...project, root: "D:\\workspace\\beta", name: "Beta" } });
      return true;
    });
    act(() => {
      useAppStore.setState({
        switchProject: mockSwitchProject,
        deleteProjectFromRepo: mockDeleteProjectFromRepo,
        loadProjects: () => Promise.resolve(),
        currentProject: project,
        projects,
        isMultiProject: true,
      });
    });

    render(<ProjectSwitcher variant="title" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Delete Alpha" }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Remove from list" }));
    });

    expect(mockSwitchProject).toHaveBeenCalledWith("beta");
    expect(mockDeleteProjectFromRepo).toHaveBeenCalledWith("alpha", false);
    expect(mockSwitchProject.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteProjectFromRepo.mock.invocationCallOrder[0],
    );
  });

  it("keeps the active project when it can't be left because its documents didn't save", async () => {
    mockDeleteProjectFromRepo.mockClear();
    mockSwitchProject.mockResolvedValueOnce(false);
    act(() => {
      useAppStore.setState({
        switchProject: mockSwitchProject,
        deleteProjectFromRepo: mockDeleteProjectFromRepo,
        loadProjects: () => Promise.resolve(),
        currentProject: project,
        projects,
        isMultiProject: true,
      });
    });

    render(<ProjectSwitcher variant="title" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Delete Alpha" }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Remove from list" }));
    });

    expect(mockSwitchProject).toHaveBeenCalledWith("beta");
    expect(mockDeleteProjectFromRepo).not.toHaveBeenCalled();
  });

  it("doesn't delete the active project when the switch left it open", async () => {
    mockDeleteProjectFromRepo.mockClear();
    act(() => {
      useAppStore.setState({
        switchProject: mockSwitchProject,
        deleteProjectFromRepo: mockDeleteProjectFromRepo,
        loadProjects: () => Promise.resolve(),
        currentProject: project,
        projects,
        isMultiProject: true,
      });
    });

    render(<ProjectSwitcher variant="title" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Delete Alpha" }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Remove from list" }));
    });

    expect(mockSwitchProject).toHaveBeenCalledWith("beta");
    expect(useAppStore.getState().currentProject).toBe(project);
    expect(mockDeleteProjectFromRepo).not.toHaveBeenCalled();
  });

  it("requires a merge decision before switching projects", async () => {
    act(() => {
      useAppStore.setState({
        switchProject: mockSwitchProject,
        loadProjects: () => Promise.resolve(),
        currentProject: project,
        projects,
        isMultiProject: true,
      });
      useVersioningStore.setState({
        isMerging: true,
      });
    });

    render(<ProjectSwitcher variant="title" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
    });
    const betaButton = await screen.findByRole("button", { name: "Beta" });
    act(() => {
      fireEvent.click(betaButton);
    });

    expect(await screen.findByText("Finish merge before switching projects?")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel merge and switch" }));
    });

    expect(useVersioningStore.getState().isMerging).toBe(false);
    expect(mockSwitchProject).toHaveBeenCalledWith("beta");
  });

  it("switches after canceling a merge even when workspace content is dirty", async () => {
    act(() => {
      useAppStore.setState({
        switchProject: mockSwitchProject,
        loadProjects: () => Promise.resolve(),
        currentProject: project,
        projects,
        isMultiProject: true,
      });
      useVersioningStore.setState({
        isMerging: true,
        isDirty: true,
      });
    });

    render(<ProjectSwitcher variant="title" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
    });
    const betaButton = await screen.findByRole("button", { name: "Beta" });
    act(() => {
      fireEvent.click(betaButton);
    });

    expect(await screen.findByText("Finish merge before switching projects?")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel merge and switch" }));
    });

    expect(useVersioningStore.getState().isMerging).toBe(false);
    expect(mockSwitchProject).toHaveBeenCalledWith("beta");
    expect(screen.queryByText("Save changes before continuing?")).not.toBeInTheDocument();
  });
});

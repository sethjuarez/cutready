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
const originalDiscardChanges = useAppStore.getState().discardChanges;
const originalLoadProjects = useAppStore.getState().loadProjects;
const mockSwitchProject = vi.fn(() => Promise.resolve());
const mockDiscardChanges = vi.fn(() => Promise.resolve());

describe("ProjectSwitcher safety gates", () => {
  afterEach(() => {
    mockSwitchProject.mockClear();
    mockDiscardChanges.mockClear();
    mockInvoke.mockReset();
    act(() => {
      useAppStore.setState({
        switchProject: originalSwitchProject,
        discardChanges: originalDiscardChanges,
        loadProjects: originalLoadProjects,
        currentProject: null,
        projects: [],
        isMultiProject: false,
        isDirty: false,
        isMerging: false,
        snapshotPromptOpen: false,
        pendingProjectAfterSave: null,
        loading: false,
      });
    });
  });

  it("opens the unsaved workspace modal before switching a dirty project", async () => {
    act(() => {
      useAppStore.setState({
        switchProject: mockSwitchProject,
        discardChanges: mockDiscardChanges,
        loadProjects: () => Promise.resolve(),
        currentProject: project,
        projects,
        isMultiProject: true,
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

    expect(await screen.findByText("Save changes before continuing?")).toBeInTheDocument();
    expect(mockSwitchProject).not.toHaveBeenCalled();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Save snapshot first" }));
    });

    expect(useAppStore.getState().snapshotPromptOpen).toBe(true);
    expect(useAppStore.getState().pendingProjectAfterSave).toBe("beta");
  });

  it("requires a merge decision before switching projects", async () => {
    act(() => {
      useAppStore.setState({
        switchProject: mockSwitchProject,
        loadProjects: () => Promise.resolve(),
        currentProject: project,
        projects,
        isMultiProject: true,
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

    expect(useAppStore.getState().isMerging).toBe(false);
    expect(mockSwitchProject).toHaveBeenCalledWith("beta");
  });

  it("falls through to the dirty gate after canceling a merge when switching projects", async () => {
    act(() => {
      useAppStore.setState({
        switchProject: mockSwitchProject,
        loadProjects: () => Promise.resolve(),
        currentProject: project,
        projects,
        isMultiProject: true,
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

    expect(useAppStore.getState().isMerging).toBe(false);
    expect(mockSwitchProject).not.toHaveBeenCalled();
    expect(await screen.findByText("Save changes before continuing?")).toBeInTheDocument();
  });
});

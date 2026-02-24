import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Project, ProjectSummary } from "../types/project";

/** The panels / views available in the app. */
export type AppView = "home" | "editor" | "settings";

interface AppStoreState {
  /** Current active view. */
  view: AppView;
  /** Currently open project (null if none). */
  currentProject: Project | null;
  /** List of project summaries for the home screen. */
  projects: ProjectSummary[];
  /** Whether an operation is in progress. */
  loading: boolean;

  /** Switch to a different view. */
  setView: (view: AppView) => void;

  /** Load the list of projects from the backend. */
  loadProjects: () => Promise<void>;

  /** Create a new project and open it. */
  createProject: (name: string) => Promise<void>;

  /** Open an existing project by ID. */
  openProject: (projectId: string) => Promise<void>;

  /** Save the current project. */
  saveProject: () => Promise<void>;

  /** Delete a project by ID. */
  deleteProject: (projectId: string) => Promise<void>;

  /** Clear the current project (go back to home). */
  closeProject: () => void;
}

export const useAppStore = create<AppStoreState>((set, get) => ({
  view: "home",
  currentProject: null,
  projects: [],
  loading: false,

  setView: (view) => set({ view }),

  loadProjects: async () => {
    set({ loading: true });
    try {
      const projects = await invoke<ProjectSummary[]>("list_projects");
      set({ projects });
    } catch (err) {
      console.error("Failed to load projects:", err);
    } finally {
      set({ loading: false });
    }
  },

  createProject: async (name) => {
    set({ loading: true });
    try {
      const project = await invoke<Project>("create_project", { name });
      set({ currentProject: project, view: "editor" });
      // Refresh the project list
      await get().loadProjects();
    } catch (err) {
      console.error("Failed to create project:", err);
    } finally {
      set({ loading: false });
    }
  },

  openProject: async (projectId) => {
    set({ loading: true });
    try {
      const project = await invoke<Project>("open_project", { projectId });
      set({ currentProject: project, view: "editor" });
    } catch (err) {
      console.error("Failed to open project:", err);
    } finally {
      set({ loading: false });
    }
  },

  saveProject: async () => {
    try {
      await invoke("save_project");
    } catch (err) {
      console.error("Failed to save project:", err);
    }
  },

  deleteProject: async (projectId) => {
    try {
      await invoke("delete_project", { projectId });
      // If we deleted the current project, close it
      const { currentProject } = get();
      if (currentProject?.id === projectId) {
        set({ currentProject: null, view: "home" });
      }
      await get().loadProjects();
    } catch (err) {
      console.error("Failed to delete project:", err);
    }
  },

  closeProject: () => {
    set({ currentProject: null, view: "home" });
  },
}));

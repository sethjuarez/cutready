import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { HomeDropdown } from "../components/home/HomeDropdown";
import {
  DEFAULT_HOME_AGENT,
  PROJECT_PICKER_LIMIT,
  defaultAgentId,
  defaultProjectPath,
  draftFromImportPrompt,
  isOpenProject,
  lastEditedDocument,
  noteImportCommand,
  noteMention,
  projectPickerOptions,
  resolveProjectSelection,
  samePath,
  sketchPlacement,
  timeOfDayGreeting,
  uniqueSketchTitle,
  workspaceName,
} from "../utils/home";
import type { Storyboard } from "../types/sketch";

const recent = (path: string, last_opened: string) => ({ path, last_opened });

describe("project picker", () => {
  const recents = [
    recent("C:\\talks\\older", "2026-10-01T10:00:00Z"),
    recent("C:\\talks\\newest", "2026-11-02T10:00:00Z"),
    recent("C:\\talks\\middle", "2026-10-20T10:00:00Z"),
  ];

  it("defaults to the most recently opened project", () => {
    expect(defaultProjectPath(recents)).toBe("C:\\talks\\newest");
  });

  it("defaults to nothing when there are no recent projects", () => {
    expect(defaultProjectPath([])).toBeNull();
    expect(projectPickerOptions([])).toEqual([]);
    expect(resolveProjectSelection("C:\\gone", [])).toBeNull();
  });

  it("lists the newest few, newest first", () => {
    const many = Array.from({ length: 8 }, (_, i) => recent(`/p/${i}`, `2026-10-0${i + 1}T00:00:00Z`));
    const options = projectPickerOptions(many);
    expect(options).toHaveLength(PROJECT_PICKER_LIMIT);
    expect(options[0].path).toBe("/p/7");
    expect(options.map((p) => p.path)).not.toContain("/p/0");
  });

  it("keeps a listed choice and falls back to the default otherwise", () => {
    expect(resolveProjectSelection("c:/talks/middle/", recents)).toBe("c:/talks/middle/");
    expect(resolveProjectSelection("C:\\elsewhere", recents)).toBe("C:\\talks\\newest");
    expect(resolveProjectSelection(null, recents)).toBe("C:\\talks\\newest");
  });

  it("matches the open project by its repo root or its root", () => {
    expect(samePath("C:\\a\\b\\", "c:/a/b")).toBe(true);
    expect(isOpenProject({ root: "C:\\repo\\talk", repo_root: "C:\\repo" }, "C:/repo/talk")).toBe(true);
    expect(isOpenProject({ root: "C:\\repo", repo_root: "C:\\repo" }, "C:/other")).toBe(false);
    expect(isOpenProject(null, "C:/repo")).toBe(false);
  });

  it("names a workspace after its folder", () => {
    expect(workspaceName("C:\\talks\\keynote\\")).toBe("keynote");
  });
});

describe("agent picker", () => {
  it("defaults to Planner", () => {
    expect(DEFAULT_HOME_AGENT).toBe("planner");
    expect(defaultAgentId([{ id: "writer" }, { id: "planner" }])).toBe("planner");
  });

  it("falls back to the first agent when Planner is missing", () => {
    expect(defaultAgentId([{ id: "writer" }, { id: "editor" }])).toBe("writer");
    expect(defaultAgentId([])).toBe("planner");
  });
});

describe("home helpers", () => {
  it("greets by time of day", () => {
    expect(timeOfDayGreeting(new Date(2026, 0, 1, 9))).toBe("Good morning");
    expect(timeOfDayGreeting(new Date(2026, 0, 1, 14))).toBe("Good afternoon");
    expect(timeOfDayGreeting(new Date(2026, 0, 1, 20))).toBe("Good evening");
  });

  it("finds the most recently edited document across kinds", () => {
    const doc = lastEditedDocument(
      [{ path: "a.sk", title: "A", state: "draft", row_count: 3, updated_at: "2026-10-01T00:00:00Z" } as never],
      [{ path: "b.sb", title: "B", sketch_count: 2, updated_at: "2026-10-03T00:00:00Z" } as never],
      [{ path: "c.md", title: "C", size: 1, updated_at: "not a date" } as never],
    );
    expect(doc).toMatchObject({ kind: "storyboard", path: "b.sb", sketch_count: 2 });
    expect(lastEditedDocument([], [], [])).toBeNull();
  });

  it("places a sketch in its storyboard section", () => {
    const storyboard = {
      title: "Keynote",
      items: [
        { type: "sketch_ref", path: "intro.sk" },
        { type: "section", title: "Demos", sketches: ["demo.sk"] },
      ],
    } as unknown as Storyboard;
    expect(sketchPlacement(storyboard, "intro.sk")).toEqual({ section: null });
    expect(sketchPlacement(storyboard, "demo.sk")).toEqual({ section: "Demos" });
    expect(sketchPlacement(storyboard, "other.sk")).toBeNull();
  });

  it("picks the import command by extension", () => {
    expect(noteImportCommand("C:\\deck.PPTX")).toBe("import_pptx");
    expect(noteImportCommand("spec.docx")).toBe("import_docx");
    expect(noteImportCommand("paper.pdf")).toBe("import_pdf");
    expect(noteImportCommand("notes.md")).toBe("import_markdown");
    expect(noteImportCommand("movie.mp4")).toBeNull();
  });

  it("asks Planner to draft from the imported note", () => {
    expect(noteMention("imports/my deck.md")).toBe('@"note:imports/my deck.md"');
    expect(draftFromImportPrompt("deck.md", "deck")).toContain('one planning row per slide. @"note:deck.md"');
    expect(draftFromImportPrompt("spec.md", "document")).toMatch(/^Draft a storyboard/);
  });

  it("numbers blank sketch titles past existing ones", () => {
    expect(uniqueSketchTitle([])).toBe("Untitled sketch");
    expect(uniqueSketchTitle(["untitled-sketch.sk", "untitled-sketch-2.sk"])).toBe("Untitled sketch 3");
  });
});

describe("HomeDropdown", () => {
  it("shows the selection, picks an option and runs the trailing action", () => {
    const onSelect = vi.fn();
    const onAction = vi.fn();
    render(
      <HomeDropdown
        label="Agent"
        options={[{ value: "planner", label: "Planner" }, { value: "writer", label: "Writer" }]}
        selected="planner"
        onSelect={onSelect}
        action={{ label: "Open folder…", onSelect: onAction }}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Agent: Planner" });
    fireEvent.click(trigger);
    expect(screen.getByRole("option", { name: "Planner" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("option", { name: "Writer" }));
    expect(onSelect).toHaveBeenCalledWith("writer");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Open folder…" }));
    expect(onAction).toHaveBeenCalled();
  });

  it("shows the empty text when there is nothing to pick", () => {
    render(<HomeDropdown label="Project" options={[]} selected={null} onSelect={() => {}} placeholder="No project" emptyText="No recent projects" />);
    fireEvent.click(screen.getByRole("button", { name: "Project: No project" }));
    expect(screen.getByText("No recent projects")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "Project: No project" }), { key: "Escape" });
    expect(screen.queryByText("No recent projects")).not.toBeInTheDocument();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  Channel: class {},
}));

import { commandErrorText, transferConflictPath } from "../services/commandErrors";
import { useAppStore } from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";

describe("commandErrorText", () => {
  it("shows a CmdError rejection's message, exactly as the old string", () => {
    expect(commandErrorText({ code: "command_failed", message: "Directory does not exist: D:\\x" })).toBe(
      "Directory does not exist: D:\\x",
    );
    expect(commandErrorText("Directory does not exist: D:\\x")).toBe("Directory does not exist: D:\\x");
  });

  it("keeps String() text for JS errors and non-envelope values", () => {
    expect(commandErrorText(new Error("boom"))).toBe("Error: boom");
    expect(commandErrorText(undefined)).toBe("undefined");
    expect(commandErrorText(42)).toBe("42");
    expect(commandErrorText({ code: "command_failed" })).toBe("[object Object]");
  });
});

describe("transferConflictPath", () => {
  it("reads the file_exists CmdError", () => {
    expect(
      transferConflictPath({ code: "file_exists", message: "FILE_EXISTS:notes/a.md", details: { path: "notes/a.md" } }),
    ).toBe("notes/a.md");
    expect(transferConflictPath({ code: "file_exists", message: "FILE_EXISTS:notes/a.md" })).toBe("notes/a.md");
    expect(transferConflictPath({ code: "file_exists", message: "exists" })).toBe("");
  });

  it("still accepts the legacy string and ignores other failures", () => {
    expect(transferConflictPath("FILE_EXISTS:notes/a.md")).toBe("notes/a.md");
    expect(transferConflictPath("Source not found")).toBeNull();
    expect(transferConflictPath({ code: "command_failed", message: "FILE_EXISTS:notes/a.md" })).toBeNull();
    expect(transferConflictPath(new Error("FILE_EXISTS:x"))).toBeNull();
    expect(transferConflictPath(null)).toBeNull();
  });
});

describe("project commands rejecting with CmdError", () => {
  afterEach(() => {
    mockInvoke.mockReset();
    useAppStore.setState({ error: null });
    vi.restoreAllMocks();
  });

  it("stores the same error text when creating a project fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockInvoke.mockRejectedValueOnce({ code: "command_failed", message: "Project 'demo' already exists" });

    await useAppStore.getState().createProjectInRepo("demo");

    expect(useAppStore.getState().error).toBe("Project 'demo' already exists");
  });

  it("shows the same toast and error when deleting a project fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const show = vi.spyOn(useToastStore.getState(), "show");
    const rejection = { code: "command_failed", message: "Project 'demo' not found in repo" };
    mockInvoke.mockRejectedValueOnce(rejection);

    await expect(useAppStore.getState().deleteProjectFromRepo("demo")).rejects.toBe(rejection);

    expect(useAppStore.getState().error).toBe("Could not delete project: Project 'demo' not found in repo");
    expect(show).toHaveBeenCalledWith("Could not delete project: Project 'demo' not found in repo", 5000, "error");
  });
});

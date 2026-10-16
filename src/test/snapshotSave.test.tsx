import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  Channel: class {},
}));

import { SnapshotDialog } from "../components/SnapshotDialog";
import { useAppStore } from "../stores/appStore";

const originalSaveVersion = useAppStore.getState().saveVersion;
const originalLoadGraphData = useAppStore.getState().loadGraphData;
const originalLoadTimelines = useAppStore.getState().loadTimelines;

describe("snapshot save naming flow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockInvoke.mockReset();
    act(() => {
      useAppStore.setState({
        snapshotPromptOpen: false,
        pendingNavAfterSave: null,
        pendingTimelineAfterSave: null,
        isRewound: false,
        saving: false,
        saveVersion: originalSaveVersion,
        loadGraphData: originalLoadGraphData,
        loadTimelines: originalLoadTimelines,
      });
    });
  });

  it("quickSave opens the naming prompt instead of creating an auto-named snapshot", async () => {
    await useAppStore.getState().quickSave();

    expect(useAppStore.getState().snapshotPromptOpen).toBe(true);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("canceling the snapshot dialog does not save", async () => {
    const saveVersion = vi.fn();
    act(() => {
      useAppStore.setState({
        snapshotPromptOpen: true,
        saveVersion,
      });
    });

    render(<SnapshotDialog />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(saveVersion).not.toHaveBeenCalled();
    expect(useAppStore.getState().snapshotPromptOpen).toBe(false);
  });

  it("shows who the snapshot will be saved as", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => cmd === "get_contributor_identity"
      ? {
          name: "Ada Lovelace",
          email: "ada@example.com",
          name_source: "git_config",
          email_source: "git_config",
          profile: null,
          needs_setup: false,
        }
      : undefined);
    act(() => {
      useAppStore.setState({ snapshotPromptOpen: true, saveVersion: vi.fn() });
    });

    render(<SnapshotDialog />);

    expect(await screen.findByTestId("snapshot-identity")).toHaveTextContent("Ada Lovelace <ada@example.com>");
    expect(screen.queryByLabelText("Your email")).toBeNull();
  });

  it("asks for a name and email before the first attributed snapshot", async () => {
    const calls: string[] = [];
    mockInvoke.mockImplementation(async (cmd: string, args?: { name: string; email: string }) => {
      calls.push(cmd);
      if (cmd === "get_contributor_identity") {
        return { name: "ada", email: null, name_source: "system", email_source: null, profile: null, needs_setup: true };
      }
      if (cmd === "set_contributor_identity") {
        return {
          name: args!.name,
          email: args!.email,
          name_source: "profile",
          email_source: "profile",
          profile: { name: args!.name, email: args!.email },
          needs_setup: false,
        };
      }
      return undefined;
    });
    const saveVersion = vi.fn(async () => { calls.push("saveVersion"); });
    act(() => {
      useAppStore.setState({
        snapshotPromptOpen: true,
        saveVersion,
        loadGraphData: vi.fn(async () => {}),
        loadTimelines: vi.fn(async () => {}),
      });
    });

    render(<SnapshotDialog />);

    const nameInput = await screen.findByLabelText("Your name");
    expect(nameInput).toHaveValue("ada");
    const save = screen.getByRole("button", { name: "Save Snapshot" });
    expect(save).toBeDisabled();

    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Ada Lovelace");
    await userEvent.type(screen.getByLabelText("Your email"), "ada@example.com");
    await userEvent.click(save);

    expect(mockInvoke).toHaveBeenCalledWith("set_contributor_identity", { name: "Ada Lovelace", email: "ada@example.com" });
    expect(calls.indexOf("set_contributor_identity")).toBeLessThan(calls.indexOf("saveVersion"));
    expect(useAppStore.getState().snapshotPromptOpen).toBe(false);
  });

  it("keeps Save disabled until the identity resolves", async () => {
    let resolveIdentity: (value: unknown) => void = () => {};
    mockInvoke.mockImplementation((cmd: string) => cmd === "get_contributor_identity"
      ? new Promise((resolve) => { resolveIdentity = resolve; })
      : Promise.resolve(undefined));
    const saveVersion = vi.fn();
    act(() => {
      useAppStore.setState({ snapshotPromptOpen: true, saveVersion });
    });

    render(<SnapshotDialog />);

    const save = screen.getByRole("button", { name: "Save Snapshot" });
    expect(save).toBeDisabled();
    await userEvent.click(save);
    expect(saveVersion).not.toHaveBeenCalled();

    await act(async () => {
      resolveIdentity({
        name: "Ada Lovelace",
        email: "ada@example.com",
        name_source: "git_config",
        email_source: "git_config",
        profile: null,
        needs_setup: false,
      });
    });
    expect(await screen.findByTestId("snapshot-identity")).toBeInTheDocument();
    expect(save).toBeEnabled();
  });

  it("blocks saving when the identity cannot be loaded", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_contributor_identity") throw new Error("store unavailable");
      return undefined;
    });
    const saveVersion = vi.fn();
    act(() => {
      useAppStore.setState({ snapshotPromptOpen: true, saveVersion });
    });

    render(<SnapshotDialog />);

    expect(await screen.findByTestId("snapshot-identity-error")).toHaveTextContent("store unavailable");
    expect(screen.getByRole("button", { name: "Save Snapshot" })).toBeDisabled();
    expect(saveVersion).not.toHaveBeenCalled();
  });
});

describe("contributor identity errors", () => {
  it("ignores an identity load that finishes after a newer identity was set", async () => {
    const { renderHook } = await import("@testing-library/react");
    const { useContributorIdentity } = await import("../hooks/useContributorIdentity");
    let rejectLoad: (err: Error) => void = () => {};
    mockInvoke.mockImplementation((cmd: string) => cmd === "get_contributor_identity"
      ? new Promise((_, reject) => { rejectLoad = reject; })
      : Promise.resolve(undefined));
    const saved = {
      name: "Jess",
      email: "jess@example.com",
      name_source: "profile",
      email_source: "profile",
      profile: { name: "Jess", email: "jess@example.com" },
      needs_setup: false,
    } as const;

    const { result } = renderHook(() => useContributorIdentity());
    act(() => result.current.setIdentity(saved));
    await act(async () => {
      rejectLoad(new Error("late failure"));
      await Promise.resolve();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.identity).toEqual(saved);
  });

  it("lets the user recover from an unreadable saved profile by saving a new one", async () => {
    const { ProfileTab } = await import("../components/settings/ProfileTab");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_contributor_identity") throw new Error("Couldn't read your saved profile: invalid type");
      if (cmd === "set_contributor_identity") {
        return {
          name: "Jess",
          email: "jess@example.com",
          name_source: "profile",
          email_source: "profile",
          profile: { name: "Jess", email: "jess@example.com" },
          needs_setup: false,
        };
      }
      return undefined;
    });

    render(<ProfileTab />);
    expect(await screen.findByText(/Couldn't read your saved profile/)).toBeInTheDocument();

    await userEvent.type(screen.getByTestId("profile-name-input"), "Jess");
    await userEvent.type(screen.getByTestId("profile-email-input"), "jess@example.com");
    await userEvent.click(screen.getByTestId("profile-save"));

    expect(await screen.findByText("Saved. New snapshots use this identity.")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't read your saved profile/)).not.toBeInTheDocument();
    expect(screen.getByTestId("profile-current")).toHaveTextContent("jess@example.com");
  });

  it("recognizes the backend identity-required error by code or message", async () => {
    const { isContributorIdentityRequired } = await import("../services/identity");
    expect(isContributorIdentityRequired({ code: "contributor_identity_required", message: "x" })).toBe(true);
    expect(isContributorIdentityRequired(
      "Add your name and email in Settings › Profile so collaborators can see who made this change.",
    )).toBe(true);
    expect(isContributorIdentityRequired({ code: "cutready_context_error", message: "boom" })).toBe(false);
    expect(isContributorIdentityRequired("Push rejected")).toBe(false);
    expect(isContributorIdentityRequired(null)).toBe(false);
  });
});

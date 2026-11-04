import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  Channel: class {},
}));

vi.mock("../services/versionOperation", () => ({
  isSaveBlocked: () => false,
  runVersionOperation: (_operation: string, action: (summary: unknown) => Promise<unknown>) =>
    action({ documents: [{ path: "intro.sk" }], totals: {} }),
}));

import { VersionForm } from "../components/versioning/VersionForm";
import { useVersioningStore } from "../stores/versioningStore";

const original = useVersioningStore.getState();

const resolved = (name: string, email: string) => ({
  name,
  email,
  name_source: "profile",
  email_source: "profile",
  profile: { name, email },
  needs_setup: false,
});

describe("Version form identity", () => {
  afterEach(() => {
    mockInvoke.mockReset();
    act(() => useVersioningStore.setState(original, true));
  });

  it("asks who is saving inline before the first version", async () => {
    const calls: string[] = [];
    mockInvoke.mockImplementation(async (cmd: string, args?: { name: string; email: string }) => {
      calls.push(cmd);
      if (cmd === "get_contributor_identity") {
        return { name: "ada", email: null, name_source: "system", email_source: null, profile: null, needs_setup: true };
      }
      if (cmd === "set_contributor_identity") return resolved(args!.name, args!.email);
      return undefined;
    });
    const saveVersion = vi.fn(async () => { calls.push("saveVersion"); });
    act(() => useVersioningStore.setState({ saveVersion }));

    render(<VersionForm />);

    const author = await screen.findByLabelText("Your name");
    await waitFor(() => expect(author).toHaveValue("ada"));
    await userEvent.type(screen.getByTestId("version-name-input"), "First pass");
    await userEvent.click(screen.getByTestId("version-save"));
    expect(saveVersion).not.toHaveBeenCalled();

    await userEvent.clear(author);
    await userEvent.type(author, "Ada Lovelace");
    await userEvent.type(screen.getByLabelText("Your email"), "ada@example.com");
    await userEvent.click(screen.getByTestId("version-save"));

    expect(mockInvoke).toHaveBeenCalledWith("set_contributor_identity", { name: "Ada Lovelace", email: "ada@example.com" });
    expect(calls.indexOf("set_contributor_identity")).toBeLessThan(calls.indexOf("saveVersion"));
    expect(saveVersion).toHaveBeenCalledWith("First pass");
  });

  it("doesn't ask once an identity is known", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => cmd === "get_contributor_identity" ? resolved("Ada", "ada@example.com") : undefined);
    render(<VersionForm />);
    await act(async () => undefined);
    expect(screen.queryByTestId("version-identity")).toBeNull();
  });

  it("keeps Save disabled until the identity resolves", async () => {
    let resolveIdentity: (value: unknown) => void = () => {};
    mockInvoke.mockImplementation((cmd: string) => cmd === "get_contributor_identity"
      ? new Promise((resolve) => { resolveIdentity = resolve; })
      : Promise.resolve(undefined));
    render(<VersionForm />);
    expect(screen.getByTestId("version-save")).toBeDisabled();
    await act(async () => resolveIdentity(resolved("Ada", "ada@example.com")));
    expect(screen.getByTestId("version-save")).toBeEnabled();
  });

  it("blocks saving when the identity cannot be loaded", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_contributor_identity") throw new Error("store unavailable");
      return undefined;
    });
    const saveVersion = vi.fn();
    act(() => useVersioningStore.setState({ saveVersion }));
    render(<VersionForm />);
    expect(await screen.findByTestId("version-identity-error")).toBeInTheDocument();
    expect(screen.getByTestId("version-save")).toBeDisabled();
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

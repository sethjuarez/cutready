import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubConnectionCard } from "../components/GitHubConnectionCard";
import {
  getGitHubAuthStatus,
  pollGitHubDeviceCode,
  signOutGitHub,
  startGitHubDeviceCode,
} from "../services/githubSetup";

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/githubSetup", () => ({
  getGitHubAuthStatus: vi.fn(),
  startGitHubDeviceCode: vi.fn(),
  pollGitHubDeviceCode: vi.fn(),
  signOutGitHub: vi.fn(),
}));

const disconnectedStatus = {
  clientConfigured: true,
  connected: false,
  account: null,
  credentialSource: null,
  ghCli: {
    installed: false,
    authenticated: false,
    path: null,
  },
};

const connectedStatus = {
  clientConfigured: true,
  connected: true,
  account: {
    login: "octomarketer",
    name: "Octo Marketer",
    avatarUrl: "https://avatars.example/octo.png",
    htmlUrl: "https://github.com/octomarketer",
  },
  credentialSource: "cutready",
  ghCli: {
    installed: false,
    authenticated: false,
    path: null,
  },
};

describe("GitHubConnectionCard", () => {
  beforeEach(() => {
    vi.mocked(getGitHubAuthStatus).mockReset();
    vi.mocked(startGitHubDeviceCode).mockReset();
    vi.mocked(pollGitHubDeviceCode).mockReset();
    vi.mocked(signOutGitHub).mockReset();
    vi.mocked(shellOpen).mockReset();
  });

  it("starts device authorization, opens GitHub, polls, and refreshes connected status", async () => {
    vi.mocked(getGitHubAuthStatus)
      .mockResolvedValueOnce(disconnectedStatus)
      .mockResolvedValueOnce(connectedStatus);
    vi.mocked(startGitHubDeviceCode).mockResolvedValue({
      deviceCode: "device-123",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 1,
    });
    vi.mocked(pollGitHubDeviceCode).mockResolvedValue({
      account: connectedStatus.account,
    });

    render(<GitHubConnectionCard />);

    fireEvent.click(await screen.findByRole("button", { name: /connect github/i }));

    await waitFor(() => {
      expect(startGitHubDeviceCode).toHaveBeenCalledTimes(1);
      expect(shellOpen).toHaveBeenCalledWith("https://github.com/login/device");
      expect(pollGitHubDeviceCode).toHaveBeenCalledWith("device-123", 1, 900);
    });
    expect(await screen.findByText(/connected as octomarketer/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /disconnect/i })).toBeInTheDocument();
  });
});

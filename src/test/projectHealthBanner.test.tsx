import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ProjectHealthBanner } from "../components/ProjectHealthBanner";
import { useAppStore } from "../stores/appStore";
import { HEALTHY_PROJECT } from "../services/draftlineVersioning";

const recovery = { operation_id: "op-1", operation: "save_version", completed: false } as never;

describe("ProjectHealthBanner", () => {
  afterEach(() => {
    useAppStore.setState({ projectHealth: HEALTHY_PROJECT, projectHealthBusy: false });
  });

  it("renders nothing for a healthy project", () => {
    useAppStore.setState({ projectHealth: HEALTHY_PROJECT });
    const { container } = render(<ProjectHealthBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers Finish and Dismiss for an interrupted operation", () => {
    const resolveRecovery = vi.fn().mockResolvedValue(undefined);
    const dismissRecovery = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      projectHealth: { ...HEALTHY_PROJECT, recovery },
      resolveRecovery,
      dismissRecovery,
    });
    render(<ProjectHealthBanner />);
    expect(screen.getByTestId("project-health-recovery")).toHaveTextContent("A save was interrupted");
    fireEvent.click(screen.getByText("Finish"));
    fireEvent.click(screen.getByText("Dismiss"));
    expect(resolveRecovery).toHaveBeenCalledOnce();
    expect(dismissRecovery).toHaveBeenCalledOnce();
  });

  it("shows no actions when another folder owns the recovery", () => {
    useAppStore.setState({ projectHealth: { ...HEALTHY_PROJECT, recovery, recoveryInOtherFolder: true } });
    render(<ProjectHealthBanner />);
    expect(screen.getByTestId("project-health-recovery")).toBeInTheDocument();
    expect(screen.queryByText("Finish")).toBeNull();
  });

  it("offers Clear lock for a stale lock and disables actions while busy", () => {
    useAppStore.setState({
      projectHealth: { ...HEALTHY_PROJECT, staleLock: { operation: "switch_variation", processId: 42 } },
      projectHealthBusy: true,
    });
    render(<ProjectHealthBanner />);
    expect(screen.getByTestId("project-health-stale-lock")).toHaveTextContent("branch switch");
    expect(screen.getByText("Clear lock")).toBeDisabled();
  });

  it("offers Download for files whose content is missing", () => {
    const retryContentDownload = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      projectHealth: { ...HEALTHY_PROJECT, missingContent: ["a.png", "b.png"] },
      retryContentDownload,
    });
    render(<ProjectHealthBanner />);
    expect(screen.getByTestId("project-health-missing-content")).toHaveTextContent("2 large files");
    fireEvent.click(screen.getByText("Download"));
    expect(retryContentDownload).toHaveBeenCalledOnce();
  });
});

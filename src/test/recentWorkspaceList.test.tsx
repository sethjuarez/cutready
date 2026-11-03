import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RecentWorkspaceList } from "../components/RecentWorkspaceList";
import { formatRelativeDate } from "../utils/relativeDate";

describe("formatRelativeDate", () => {
  const now = new Date("2026-11-02T12:00:00Z");

  it("uses short relative units under a week", () => {
    expect(formatRelativeDate("2026-11-02T11:59:40Z", now)).toBe("just now");
    expect(formatRelativeDate("2026-11-02T11:15:00Z", now)).toBe("45m ago");
    expect(formatRelativeDate("2026-11-02T07:00:00Z", now)).toBe("5h ago");
    expect(formatRelativeDate("2026-10-30T12:00:00Z", now)).toBe("3d ago");
  });

  it("falls back to a date after a week", () => {
    const iso = "2026-10-01T12:00:00Z";
    expect(formatRelativeDate(iso, now)).toBe(new Date(iso).toLocaleDateString());
  });
});

describe("RecentWorkspaceList", () => {
  const projects = [
    { path: "C:\\work\\partner-pitch", last_opened: new Date().toISOString() },
    { path: "/home/me/launch", last_opened: new Date().toISOString() },
  ];

  it("opens and removes workspaces by their folder name", () => {
    const onOpen = vi.fn();
    const onRemove = vi.fn();
    render(<RecentWorkspaceList projects={projects} onOpen={onOpen} onRemove={onRemove} />);

    expect(screen.getByRole("list", { name: "Recent workspaces" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Open partner-pitch workspace" }));
    expect(onOpen).toHaveBeenCalledWith("C:\\work\\partner-pitch");

    fireEvent.click(screen.getByRole("button", { name: "Remove launch from recent" }));
    expect(onRemove).toHaveBeenCalledWith("/home/me/launch");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

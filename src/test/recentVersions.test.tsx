import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));

import { RecentVersions } from "../components/versioning/RecentVersions";
import { useVersioningStore } from "../stores/versioningStore";
import type { GraphNode } from "../types/sketch";

function node(id: string, message: string, comment?: string): GraphNode {
  return {
    id,
    message,
    comment,
    timestamp: "2026-11-04T10:00:00.000Z",
    timeline: "main",
    parents: [],
    lane: 0,
    is_head: id === "b",
  };
}

describe("RecentVersions", () => {
  it("shows a version's comment under its name", () => {
    useVersioningStore.setState({ graphNodes: [{ ...node("b", "Tighten intro", "Cut the second demo."), parents: ["a"] }, node("a", "First draft")] });

    render(<RecentVersions onNavigate={() => {}} />);

    expect(screen.getByRole("button", { name: "Preview version: Tighten intro" })).toHaveTextContent("Cut the second demo.");
    expect(screen.getAllByTestId("recent-version-comment")).toHaveLength(1);
  });
});

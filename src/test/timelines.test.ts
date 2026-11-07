import { describe, expect, it } from "vitest";
import { emptyStartedTimeline, filterRemoteTimelines, filterTimelines, timelineNameProblem } from "../domain/versioning";
import type { GraphNode, RemoteBranchInfo, TimelineInfo } from "../types/sketch";

const timeline = (name: string, active = false, label = name): TimelineInfo =>
  ({ name, label, is_active: active, snapshot_count: 1, color_index: 0 });
const branch = (id: string): RemoteBranchInfo => ({ id, name: id, remote: "origin" });
const node = (id: string, head: boolean) => ({ id, is_head: head }) as GraphNode;

describe("filterTimelines", () => {
  const all = [timeline("alpha"), timeline("main", true), timeline("beta", false, "Beta take")];

  it("puts the current timeline first", () => {
    expect(filterTimelines(all, "").map((t) => t.name)).toEqual(["main", "alpha", "beta"]);
  });

  it("matches labels case-insensitively", () => {
    expect(filterTimelines(all, " TAKE ").map((t) => t.name)).toEqual(["beta"]);
  });
});

describe("filterRemoteTimelines", () => {
  it("hides remote timelines that exist locally and applies the filter", () => {
    const local = [timeline("main", true)];
    const remote = [branch("main"), branch("review"), branch("draft")];
    expect(filterRemoteTimelines(remote, local, "").map((b) => b.id)).toEqual(["review", "draft"]);
    expect(filterRemoteTimelines(remote, local, "rev").map((b) => b.id)).toEqual(["review"]);
  });
});

describe("emptyStartedTimeline", () => {
  const started = { branchName: "try", snapshotId: "v1" };

  it("names a timeline still sitting on the version it started from", () => {
    expect(emptyStartedTimeline(started, timeline("try", true), [node("v1", true)])).toBe("try");
  });

  it("is null once the timeline has a save of its own", () => {
    expect(emptyStartedTimeline(started, timeline("try", true), [node("v2", true), node("v1", false)])).toBeNull();
  });

  it("is null on another timeline or without a start", () => {
    expect(emptyStartedTimeline(started, timeline("main", true), [node("v1", true)])).toBeNull();
    expect(emptyStartedTimeline(null, timeline("try", true), [node("v1", true)])).toBeNull();
  });
});

describe("timelineNameProblem", () => {
  const all = [timeline("main", true), timeline("cutready/alt", false, "Alt")];

  it("requires a name", () => {
    expect(timelineNameProblem("  ", all)).toBe("Enter a name.");
  });

  it("rejects names or labels already in use", () => {
    expect(timelineNameProblem("main", all)).toMatch(/already exists/);
    expect(timelineNameProblem("Alt", all)).toMatch(/already exists/);
  });

  it("allows keeping the current name while renaming", () => {
    expect(timelineNameProblem("main", all, "main")).toBeNull();
    expect(timelineNameProblem("fresh", all)).toBeNull();
  });
});

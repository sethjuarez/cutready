import { describe, expect, it } from "vitest";
import { isUserSave, reviewRequest, savesToSend, versionDisplayName } from "../domain/versioning";
import type { GraphNode } from "../types/sketch";

function node(id: string, message: string, parents: string[], extra: Partial<GraphNode> = {}): GraphNode {
  return { id, message, parents, timestamp: "", timeline: "main", lane: 0, is_head: false, ...extra };
}
const shared = { reachable_from_remote_variation: true };
const SYNC_LABEL = "chore(sync): bring in team updates (#30, #29, #28…)";
const SYNC_COMMENT = "- #30 hero copy (Dana)\n- #29 pricing (Lee)\n- #28 lead queue (Dana)";

// Seth's history: an older team-update version, then his save, then the
// automatic team-update version Send made when it couldn't replay his saves.
const SETH = [
  node("m2", SYNC_LABEL, ["s", "t30"], { is_head: true, comment: SYNC_COMMENT }),
  node("t30", "#30 hero copy", ["t29"], shared),
  node("t29", "#29 pricing", ["t28"], shared),
  node("t28", "#28 lead queue", ["t25"], shared),
  node("s", "initial outline", ["m1"], { comment: "first pass" }),
  node("m1", "Bring in team updates", ["base", "t25"], { comment: "- #25 nav (Lee)" }),
  node("t25", "#25 nav", ["base"], shared),
  node("base", "#24 setup", [], shared),
];

describe("reviewRequest", () => {
  it("names the review after the newest save when the tip is a team-update version", () => {
    const review = reviewRequest(SETH, 3);
    expect(review.title).toBe("initial outline");
    expect(review.body).toBe("first pass\n\nAlso includes 4 team updates that are already shared; they aren't part of this review.");
  });

  it("never lists teammates' saves brought in by a team-update version", () => {
    const { body } = reviewRequest(SETH, 3);
    for (const teammate of ["#25", "#28", "#29", "#30", "hero copy", "chore(sync)"]) expect(body).not.toContain(teammate);
  });

  it("lists several saves oldest first, titled after the newest", () => {
    const nodes = [
      node("m", "Bring in team updates", ["s2", "t"], { is_head: true, comment: "- #30 hero copy (Dana)" }),
      node("s2", "tighten intro", ["s1"]),
      node("s1", "initial outline", ["base"]),
      node("t", "#30 hero copy", ["base"], shared),
      node("base", "#27", [], shared),
    ];
    expect(reviewRequest(nodes, 3)).toEqual({
      title: "tighten intro",
      body: "Saves in this review:\n- initial outline\n- tighten intro\n\nAlso includes 1 team update that is already shared; they aren't part of this review.",
    });
  });

  it("stops at versions the remote already has after a replay", () => {
    const nodes = [node("s", "initial outline", ["t"], { is_head: true }), node("t", "#30 hero copy", ["base"]), node("base", "#27", [])];
    expect(reviewRequest(nodes, 1)).toEqual({ title: "initial outline", body: "" });
  });

  it("puts a save just made by Save & send first", () => {
    const review = reviewRequest(SETH, 3, { name: "final cut", comment: "" });
    expect(review.title).toBe("final cut");
    expect(review.body).toMatch(/^Saves in this review:\n- initial outline\n- final cut\n\nAlso includes/);
  });

  it("says team updates without a count when a version doesn't list them", () => {
    const nodes = [node("m", "Sync", ["s", "t"], { is_head: true }), node("s", "outline", ["base"]), node("t", "x", ["base"], shared), node("base", "b", [], shared)];
    expect(reviewRequest(nodes, 2).body).toBe("Also includes team updates that are already shared; they aren't part of this review.");
  });

  it("falls back to a neutral title with no saves", () => {
    expect(reviewRequest([node("m", "Bring in team updates", ["a", "b"], { is_head: true })], 1, undefined, "Update talk").title).toBe("Update talk");
  });

  it("never names the review after a teammate's save behind an unsent team-update version", () => {
    const nodes = [
      node("m", "Bring in team updates", ["t1", "t2"], { is_head: true, comment: "- #31 footer (Lee)" }),
      node("t2", "#31 footer", ["t1"], shared),
      node("t1", "#30 hero copy", ["base"], { ...shared, comment: "Dana's notes" }),
      node("base", "#27", [], shared),
    ];
    expect(reviewRequest(nodes, 1, undefined, "Update talk")).toEqual({
      title: "Update talk",
      body: "Also includes 1 team update that is already shared; they aren't part of this review.",
    });
  });

  it("treats merging the person's own variation as their save, not team updates", () => {
    const nodes = [
      node("m", "Merge updates from Draft", ["s1", "d1"], { is_head: true }),
      node("d1", "alt opening", ["base"]),
      node("s1", "initial outline", ["base"]),
      node("base", "#27", [], shared),
    ];
    const review = reviewRequest(nodes, 3);
    expect(review.title).toBe("Merge updates from Draft");
    expect(review.body).not.toContain("team update");
    expect(savesToSend(nodes, 3)).toBe(2);
  });
});

describe("savesToSend", () => {
  it("counts saves, not team-update versions", () => {
    expect(savesToSend(SETH, 3)).toBe(1);
  });

  it("stays above zero while only a team-update version is unsent", () => {
    expect(savesToSend([node("m", "Bring in team updates", ["s", "t"], { is_head: true }), node("s", "a", [], shared)], 1)).toBe(1);
  });

  it("uses the remote's count before history loads, and 0 when nothing is unsent", () => {
    expect(savesToSend([], 4)).toBe(4);
    expect(savesToSend(SETH, 0)).toBe(0);
  });
});

describe("version names", () => {
  it("treats merges that only brought in shared work as automatic", () => {
    const index = new Map([["b", node("b", "#30", [], shared)], ["c", node("c", "mine", [])]]);
    expect(isUserSave(node("x", "initial outline", ["a"]))).toBe(true);
    expect(isUserSave(node("x", "Sync", ["a", "b"]), index)).toBe(false);
    expect(isUserSave(node("x", "Merge updates from Draft", ["a", "c"]), index)).toBe(true);
    // Without the other parent in view, the generated name decides.
    expect(isUserSave(node("x", "Bring in team updates", ["a", "z"]))).toBe(false);
    expect(isUserSave(node("x", "Combine intros", ["a", "z"]))).toBe(true);
  });

  it("shows team-update versions in plain words", () => {
    expect(versionDisplayName(SETH[0])).toBe("Brought in team updates");
    expect(versionDisplayName(SETH[4])).toBe("initial outline");
  });
});

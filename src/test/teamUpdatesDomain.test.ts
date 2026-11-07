import { describe, expect, it } from "vitest";
import {
  incomingAuthors,
  isTeamUpdatesName,
  plainVersion,
  syncCopy,
  teammates,
  teamUpdatesLabel,
  teamUpdatesNameKind,
  usesConventionalNames,
} from "../domain/versioning";

describe("team update labels", () => {
  it("names the version plainly and lists what came in as its comment", () => {
    expect(teamUpdatesLabel([
      { name: "#24 lead queue with wing-light hero", comment: "", author: "Dana" },
      { name: "  tighten\n outro ", comment: "" },
    ])).toBe("Bring in team updates\n\n- #24 lead queue with wing-light hero (Dana)\n- tighten outro");
    expect(teamUpdatesLabel([])).toBe("Bring in team updates");
    expect(teamUpdatesLabel([{ name: "#24 a", comment: "" }, { name: "b #25 #24", comment: "" }], true))
      .toBe("chore(sync): bring in team updates (#24, #25)\n\n- #24 a\n- b #25 #24");
    expect(teamUpdatesLabel(["#1", "#2", "#3", "#4"].map((name) => ({ name, comment: "" })), true).split("\n")[0])
      .toBe("chore(sync): bring in team updates (#1, #2, #3…)");
    expect(teamUpdatesLabel([{ name: "tweak", comment: "" }], true).split("\n")[0]).toBe("chore(sync): bring in team updates");
  });

  it("caps the list and long names", () => {
    const many = Array.from({ length: 23 }, (_, i) => ({ name: `save ${i}`, comment: "" }));
    const lines = teamUpdatesLabel(many).split("\n");
    expect(lines[lines.length - 1]).toBe("- …and 3 more");
    expect(lines).toHaveLength(2 + 21);
    const long = teamUpdatesLabel([{ name: "x".repeat(300), comment: "" }]).split("\n")[2];
    expect(long.length).toBeLessThanOrEqual(122);
  });

  it("recognizes generated names, old and new", () => {
    expect(isTeamUpdatesName("Brought in team updates\n\n- a")).toBe(true);
    expect(isTeamUpdatesName("Merge updates from main")).toBe(true);
    expect(isTeamUpdatesName("Bring in team updates")).toBe(true);
    expect(isTeamUpdatesName("chore(sync): bring in team updates (#24, #25…)")).toBe(true);
    expect(teamUpdatesNameKind("chore(sync): bring in team updates (#24)")).toBe("current");
    expect(isTeamUpdatesName("Merge updates")).toBe(true);
    expect(isTeamUpdatesName("Merge the intros")).toBe(false);
  });

  it("names teammates", () => {
    expect(incomingAuthors([{ name: "a", comment: "", author: "Dana" }, { name: "b", comment: "", author: "Dana" }, { name: "c", comment: "" }])).toEqual(["Dana"]);
    expect(teammates([])).toBe("a teammate");
    expect(teammates(["Dana", "Lee"])).toBe("Dana and Lee");
    expect(teammates(["Dana", "Lee", "Kim"])).toBe("Dana, Lee and 1 other");
  });
});

describe("sync copy", () => {
  it("reads as plain status", () => {
    expect(syncCopy.savesWaiting(1)).toBe("1 save waiting to send");
    expect(syncCopy.teamHasUpdates(3)).toBe("Team has 3 new updates");
    expect(syncCopy.sent(2)).toBe("Sent ✓ (also picked up 2 team updates)");
    expect(syncCopy.sent(0, true)).toBe("Sent for review ✓");
    expect(syncCopy.gotTeamUpdates(0)).toBe("Got the team's updates.");
    expect(syncCopy.conflictTitle(["Dana"], ["cutready/compass.sk"])).toBe("You and Dana both changed compass.sk");
    expect(syncCopy.conflictTitle([], ["a.sk", "b.md"])).toBe("You and a teammate both changed 2 files");
  });
});

describe("usesConventionalNames", () => {
  it("needs most of at least three typed names to be conventional", () => {
    expect(usesConventionalNames(["feat: a", "fix(ui): b", "intro"])).toBe(true);
    expect(usesConventionalNames(["feat: a", "intro", "outro"])).toBe(false);
    expect(usesConventionalNames(["feat: a", "fix: b"])).toBe(false);
    expect(usesConventionalNames(["feat: a", "fix: b", "Bring in team updates", "Merge updates"])).toBe(false);
  });
});

describe("plainVersion", () => {
  it("renames generated update versions and summarizes what came in", () => {
    expect(plainVersion("Brought in team updates", "- Hero (Dana)\n- Intro (Lee)", true)).toEqual({
      name: "Brought in team updates",
      comment: "Hero (Dana) and 1 more",
      teamUpdates: ["Hero (Dana)", "Intro (Lee)"],
    });
  });

  it("recognizes a commit-template prefix", () => {
    expect(plainVersion("[CutReady] Brought in team updates", "- Hero (Dana)", true).name).toBe("Brought in team updates");
    expect(plainVersion("cutready: Merge updates from main", null, true).name).toBe("Brought in team updates");
  });

  it("keeps a legacy merge's comment instead of reading it as a list", () => {
    expect(plainVersion("Merge updates from main", "- my own note", true)).toEqual({
      name: "Brought in team updates",
      comment: "- my own note",
      teamUpdates: [],
    });
  });

  it("leaves ordinary saves alone, even with a generated-looking name", () => {
    expect(plainVersion("Merge updates from main", "typed", false)).toEqual({ name: "Merge updates from main", comment: "typed", teamUpdates: [] });
    expect(plainVersion("initial outline\nmore", "first pass", true).name).toBe("initial outline");
    expect(plainVersion("Plan: Brought in team updates later", null, true).name).toBe("Plan: Brought in team updates later");
  });
});

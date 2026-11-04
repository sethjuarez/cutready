import { describe, expect, it } from "vitest";
import { summarizeChanges } from "../domain/changes";
import {
  applySuggestion,
  chipState,
  clampVersionName,
  describeSummaryForPrompt,
  discardShelfName,
  discardShelfTime,
  discardShelvesToPrune,
  DISCARD_SHELF_MAX_AGE_MS,
  MAX_VERSION_NAME,
  normalizeVersionName,
  parseSuggestion,
  sendGate,
  sendGateLabel,
  versionNameError,
} from "../domain/versioning";

describe("version names", () => {
  it("requires a name of at most 72 characters", () => {
    expect(versionNameError("  ")).toBe("Name the version");
    expect(versionNameError("x".repeat(MAX_VERSION_NAME))).toBeNull();
    expect(versionNameError("x".repeat(MAX_VERSION_NAME + 1))).toMatch(/72/);
    expect(versionNameError(`  ${"x".repeat(MAX_VERSION_NAME)}  `)).toBeNull();
    expect(normalizeVersionName(`  ${"x".repeat(MAX_VERSION_NAME)}  `)).toHaveLength(MAX_VERSION_NAME);
  });

  it("counts code points, not UTF-16 units", () => {
    expect(versionNameError("🎬".repeat(MAX_VERSION_NAME))).toBeNull();
  });

  it("clamps suggestions to the first line within the limit", () => {
    expect(clampVersionName("  Tighten intro\nmore detail")).toBe("Tighten intro");
    const clamped = clampVersionName("word ".repeat(30));
    expect([...clamped].length).toBeLessThanOrEqual(MAX_VERSION_NAME);
    expect(clamped.endsWith("…")).toBe(true);
  });
});

describe("chipState", () => {
  const base = { saving: false, saveFailed: false, changedCount: 0, toSendCount: 0 };

  it("shows the most urgent state first", () => {
    expect(chipState({ ...base, saveFailed: true, saving: true, changedCount: 3 }).kind).toBe("failed");
    expect(chipState({ ...base, saving: true, changedCount: 3 }).label).toBe("Saving…");
    expect(chipState({ ...base, changedCount: 1, toSendCount: 2 }).label).toBe("1 change");
    expect(chipState({ ...base, changedCount: 4 }).label).toBe("4 changes");
    expect(chipState({ ...base, toSendCount: 2 }).label).toBe("2 to send");
    expect(chipState(base)).toEqual({ kind: "saved", label: "Saved" });
  });

  it("uses the retry wording for save failures", () => {
    expect(chipState({ ...base, saveFailed: true }).label).toBe("Couldn't save – Retry");
  });
});

describe("sendGate", () => {
  const base = { hasRemote: true, isSyncing: false, status: { ahead: 0, behind: 0 }, changedCount: 0 };

  it("disables Send when nothing is new", () => {
    const gate = sendGate(base);
    expect(gate).toEqual({ kind: "up-to-date", toSend: 0, enabled: false });
    expect(sendGateLabel(gate, "Send")).toBe("Up to date");
  });

  it("offers Save & send when there are unsaved changes", () => {
    const gate = sendGate({ ...base, changedCount: 2, status: { ahead: 1, behind: 0 } });
    expect(gate).toEqual({ kind: "save-first", toSend: 1, enabled: true });
    expect(sendGateLabel(gate, "Send")).toBe("Save & send");
    expect(sendGateLabel(gate, "Send for review")).toBe("Save & send for review");
  });

  it("sends directly when versions are ahead and the workspace is clean", () => {
    const gate = sendGate({ ...base, status: { ahead: 3, behind: 0 } });
    expect(gate.kind).toBe("direct");
    expect(sendGateLabel(gate, "Send")).toBe("Send 3 versions");
  });

  it("syncs first when both sides moved, and waits for updates when only behind", () => {
    expect(sendGate({ ...base, status: { ahead: 1, behind: 2 } }).kind).toBe("sync");
    const behind = sendGate({ ...base, status: { ahead: 0, behind: 2 } });
    expect(behind).toMatchObject({ kind: "behind", enabled: false });
    expect(sendGateLabel(behind, "Send", 2)).toBe("Get 2 updates first");
  });

  it("is disabled without a remote, while busy, and before the first status", () => {
    expect(sendGate({ ...base, hasRemote: false, changedCount: 3 }).kind).toBe("no-remote");
    expect(sendGate({ ...base, isSyncing: true, changedCount: 3 }).enabled).toBe(false);
    expect(sendGate({ ...base, status: null, changedCount: 3 }).kind).toBe("checking");
  });
});

describe("discard shelves", () => {
  it("names each discard uniquely and reads its time back", () => {
    const name = discardShelfName(1_700_000_000_000, () => 0.5);
    expect(name).toMatch(/^cutready-discard-1700000000000-[0-9a-z]{6}$/);
    expect(discardShelfTime(name)).toBe(1_700_000_000_000);
    expect(discardShelfName(1, () => 0)).not.toBe(discardShelfName(1, () => 0.999));
  });

  it("ignores shelves it didn't make", () => {
    expect(discardShelfTime("cutready-stash")).toBeNull();
    expect(discardShelfTime("cutready-discard-abc")).toBeNull();
  });

  it("prunes only discard shelves older than the limit", () => {
    const now = 10 * DISCARD_SHELF_MAX_AGE_MS;
    const old = discardShelfName(now - DISCARD_SHELF_MAX_AGE_MS - 1);
    const fresh = discardShelfName(now - 1000);
    expect(discardShelvesToPrune([old, fresh, "cutready-stash", "my-shelf"], now)).toEqual([old]);
  });
});

describe("suggest", () => {
  const summary = summarizeChanges([
    { path: "intro.sk", status: "added" },
    { path: "notes/plan.md", status: "modified", before: "One.", after: "One.\n\nTwo more words." },
  ]);

  it("describes the summary for the model", () => {
    const text = describeSummaryForPrompt(summary);
    expect(text).toContain("intro");
    expect(text).toContain("plan");
  });

  it("parses JSON replies, including fenced ones", () => {
    expect(parseSuggestion('```json\n{"name":"Add intro","comment":"New opener."}\n```'))
      .toEqual({ name: "Add intro", comment: "New opener." });
    expect(parseSuggestion('{"name":"Only a name"}')).toEqual({ name: "Only a name", comment: "" });
  });

  it("rejects unusable replies", () => {
    expect(parseSuggestion(null)).toBeNull();
    expect(parseSuggestion("no json here")).toBeNull();
    expect(parseSuggestion('{"name": ""}')).toBeNull();
    expect(parseSuggestion("{broken")).toBeNull();
  });

  it("fills empty or previously suggested fields, and confirms before replacing typed text", () => {
    const suggestion = { name: "New", comment: "c" };
    expect(applySuggestion({ name: "", comment: "" }, suggestion, null).kind).toBe("fill");
    expect(applySuggestion({ name: "Old", comment: "" }, suggestion, { name: "Old", comment: "" }).kind).toBe("fill");
    expect(applySuggestion({ name: "Mine", comment: "" }, suggestion, null).kind).toBe("confirm");
    expect(applySuggestion({ name: "", comment: "typed" }, suggestion, null).kind).toBe("confirm");
  });
});

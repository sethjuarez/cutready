import { afterEach, describe, expect, it } from "vitest";
import { MAX_VERSION_NAME } from "../domain/versioning";
import { activeTimelineLabel, askMergeName, defaultMergeName } from "../services/mergeName";
import { useMergeNameStore } from "../stores/mergeNameStore";
import type { TimelineInfo } from "../types/sketch";

afterEach(() => useMergeNameStore.setState({ pending: null }));

const timeline = (label: string, is_active: boolean): TimelineInfo =>
  ({ name: label.toLowerCase(), label, is_active, snapshot_count: 1, color_index: 0 });

describe("defaultMergeName", () => {
  it("names the merge after where the updates come from", () => {
    expect(defaultMergeName("main")).toBe("Merge updates from main");
    expect(defaultMergeName("  ")).toBe("Merge updates");
  });

  it("stays within the version name limit", () => {
    const name = defaultMergeName("x".repeat(100));
    expect([...name].length).toBeLessThanOrEqual(MAX_VERSION_NAME);
  });
});

describe("activeTimelineLabel", () => {
  it("uses the active timeline's label", () => {
    expect(activeTimelineLabel([timeline("Draft 1", false), timeline("Keynote", true)])).toBe("Keynote");
    expect(activeTimelineLabel([timeline("Draft 1", false)])).toBeUndefined();
  });
});

describe("askMergeName", () => {
  it("prefills the default and resolves to the approved message", async () => {
    const asked = askMergeName("Keynote");
    expect(useMergeNameStore.getState().pending).toMatchObject({ source: "Keynote", defaultName: "Merge updates from Keynote" });
    useMergeNameStore.getState().answer("Merge Ana's edits");
    await expect(asked).resolves.toBe("Merge Ana's edits");
    expect(useMergeNameStore.getState().pending).toBeNull();
  });

  it("resolves to null when cancelled, so nothing is merged", async () => {
    const asked = askMergeName("main");
    useMergeNameStore.getState().answer(null);
    await expect(asked).resolves.toBeNull();
  });

  it("never replaces an open prompt; a second request is cancelled", async () => {
    const first = askMergeName("main");
    await expect(askMergeName("Keynote")).resolves.toBeNull();
    expect(useMergeNameStore.getState().pending?.source).toBe("main");
    useMergeNameStore.getState().answer("Merge updates from main");
    await expect(first).resolves.toBe("Merge updates from main");
  });
});

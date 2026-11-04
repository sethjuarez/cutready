import { describe, expect, it } from "vitest";
import type { AssetInfo, NarrationAssetInfo } from "../stores/appStore";
import {
  filterCounts,
  filterMedia,
  formatBytes,
  isUnused,
  removalPaths,
  removalPlan,
  toMediaItems,
  usedInLabel,
} from "../utils/media";

const image = (path: string, referencedBy: string[], modifiedAt = 0, assetType: AssetInfo["assetType"] = "screenshot"): AssetInfo =>
  ({ path, size: 2048, referencedBy, assetType, modifiedAt });
const take = (path: string, referencedBy: string[], mimeType = "audio/webm", modifiedAt = 0): NarrationAssetInfo =>
  ({ path, size: 512, mimeType, referencedBy, modifiedAt });

const library = toMediaItems(
  [
    image(".cutready/screenshots/used.png", ["a.sk", "notes/n.md"], 3),
    image(".cutready/screenshots/orphan.png", [], 1),
    image(".cutready/visuals/v.json", ["b.sk"], 2, "visual"),
  ],
  [
    take(".cutready/narration/row-1.webm", ["a.sk", "a.sk", "b.sk"], "audio/webm", 4),
    take(".cutready/narration/row-2.webm", [], "audio/webm", 0),
    take("recordings/raw.wav", [], "audio/wav", 0),
  ],
);
const byName = (name: string) => library.find((item) => item.name === name)!;

describe("toMediaItems", () => {
  it("merges images, visuals and audio, newest first", () => {
    expect(library.map((item) => item.name)).toEqual(["row-1.webm", "used.png", "v.json", "orphan.png", "row-2.webm", "raw.wav"]);
    expect(byName("v.json").kind).toBe("visual");
    expect(byName("row-1.webm").kind).toBe("audio");
  });

  it("splits references into sketches and notes, once each", () => {
    expect(byName("row-1.webm").sketches).toEqual(["a.sk", "b.sk"]);
    expect(byName("used.png")).toMatchObject({ sketches: ["a.sk"], notes: ["notes/n.md"] });
  });

  it("files video takes under video", () => {
    expect(toMediaItems([], [take("clip.webm", [], "video/webm")])[0].kind).toBe("video");
  });
});

describe("usage", () => {
  it("is unused when no sketch or note references it", () => {
    expect(isUnused(byName("orphan.png"))).toBe(true);
    expect(isUnused(byName("used.png"))).toBe(false);
  });

  it("labels usage", () => {
    expect(usedInLabel(byName("row-1.webm"))).toBe("Used in 2 sketches");
    expect(usedInLabel(byName("used.png"))).toBe("Used in 1 sketch and 1 note");
    expect(usedInLabel(byName("orphan.png"))).toBe("Unused");
  });
});

describe("filterMedia", () => {
  it("filters by type and by Unused", () => {
    expect(filterMedia(library, "images").map((item) => item.name)).toEqual(["used.png", "v.json", "orphan.png"]);
    expect(filterMedia(library, "audio")).toHaveLength(3);
    expect(filterMedia(library, "video")).toEqual([]);
    expect(filterMedia(library, "unused").map((item) => item.name)).toEqual(["orphan.png", "row-2.webm", "raw.wav"]);
  });

  it("narrows by a case-insensitive name search", () => {
    expect(filterMedia(library, "all", "  ROW ").map((item) => item.name)).toEqual(["row-1.webm", "row-2.webm"]);
    expect(filterMedia(library, "unused", "row").map((item) => item.name)).toEqual(["row-2.webm"]);
  });

  it("counts every chip", () => {
    expect(filterCounts(library)).toEqual({ all: 6, images: 3, video: 0, audio: 3, unused: 3 });
  });
});

describe("removalPlan", () => {
  it("removes only unused files the app manages, and keeps the rest", () => {
    const { remove, keep } = removalPlan(library);
    expect(remove.map((item) => item.path)).toEqual([".cutready/screenshots/orphan.png", ".cutready/narration/row-2.webm"]);
    expect(keep.map((item) => item.path)).toEqual(["recordings/raw.wav"]);
  });

  it("routes each path to the command that owns its folder", () => {
    expect(removalPaths(removalPlan(library).remove)).toEqual({
      images: [".cutready/screenshots/orphan.png"],
      narrations: [".cutready/narration/row-2.webm"],
    });
  });

  it("never lists a used file", () => {
    const used = library.filter((item) => !isUnused(item)).map((item) => item.path);
    expect(removalPlan(library).remove.some((item) => used.includes(item.path))).toBe(false);
  });
});

it("formats sizes", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(2048)).toBe("2.0 KB");
  expect(formatBytes(15 * 1024 * 1024)).toBe("15 MB");
});

import { describe, expect, it } from "vitest";
import { isAppleMediaPlatform, preferredNarrationMimeType } from "../utils/narrationAudio";

describe("narrationAudio", () => {
  it("prefers mp4 on Apple WebViews when available", () => {
    const supported = new Set(["audio/webm;codecs=opus", "audio/mp4"]);

    expect(preferredNarrationMimeType((mimeType) => supported.has(mimeType), "MacIntel")).toBe("audio/mp4");
  });

  it("keeps webm first on non-Apple platforms", () => {
    const supported = new Set(["audio/webm;codecs=opus", "audio/mp4"]);

    expect(preferredNarrationMimeType((mimeType) => supported.has(mimeType), "Win32")).toBe("audio/webm;codecs=opus");
  });

  it("detects Apple media platforms", () => {
    expect(isAppleMediaPlatform("MacIntel")).toBe(true);
    expect(isAppleMediaPlatform("iPhone")).toBe(true);
    expect(isAppleMediaPlatform("Linux x86_64")).toBe(false);
  });
});

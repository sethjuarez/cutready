import { describe, expect, it } from "vitest";
import { imageMimeType, versionImage } from "../domain/compare/imageData";

describe("version image data", () => {
  const b64 = (bytes: string) => btoa(bytes);

  it("prefers the magic bytes, then the extension", () => {
    expect(imageMimeType("a/shot.JPG", "")).toBe("image/jpeg");
    expect(imageMimeType("diagram.svg", "")).toBe("image/svg+xml");
    expect(imageMimeType("noext", b64("\x89PNG\r\n\x1a\n0000"))).toBe("image/png");
    expect(imageMimeType("noext", b64("GIF89a000000"))).toBe("image/gif");
    expect(imageMimeType("wrong.png", b64("\xff\xd8\xff\xe0000000"))).toBe("image/jpeg");
    expect(imageMimeType("noext", b64("RIFF0000WEBP"))).toBe("image/webp");
    expect(imageMimeType("noext", b64("RIFF0000WAVE"))).toBeNull();
    expect(imageMimeType("noext", "AAAA")).toBeNull();
  });

  it("builds a data URL, or explains why it can't", () => {
    expect(versionImage("s.webp", b64("RIFF0000WEBP"))).toEqual({ state: "ready", src: `data:image/webp;base64,${b64("RIFF0000WEBP")}` });
    expect(versionImage("blob", "AAAA").state).toBe("unavailable");
  });
});
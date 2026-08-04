import { describe, expect, it } from "vitest";
import { THEME_PALETTES, deriveContentTokens } from "../theme/appThemePalettes";

type Rgb = [number, number, number];

function toRgb(token: string): Rgb {
  const [r, g, b] = token.split(/\s+/).map(Number);
  return [r, g, b];
}

function linearize(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function contrastRatio(a: string, b: string): number {
  const luminance = (token: string) => {
    const [r, g, bb] = toRgb(token).map(linearize);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bb;
  };
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

function oklchHue(token: string): number {
  const [r, g, b] = toRgb(token).map(linearize);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const aAxis = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bAxis = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return (Math.atan2(bAxis, aAxis) * 180) / Math.PI;
}

function hueDistance(a: number, b: number): number {
  const delta = Math.abs(a - b) % 360;
  return delta > 180 ? 360 - delta : delta;
}

const MODES = ["light", "dark"] as const;

describe("derived content type tokens", () => {
  it.each(THEME_PALETTES.flatMap((palette) => MODES.map((mode) => [palette.id, mode] as const)))(
    "%s/%s stays legible and distinguishable",
    (paletteId, mode) => {
      const palette = THEME_PALETTES.find((entry) => entry.id === paletteId)!;
      const colors = palette[mode];
      const content = deriveContentTokens(colors);
      const entries = Object.values(content);

      for (const token of entries) {
        expect(contrastRatio(token, colors.surface)).toBeGreaterThanOrEqual(4.5);
      }

      const hues = entries.map(oklchHue);
      for (let i = 0; i < hues.length; i += 1) {
        for (let j = i + 1; j < hues.length; j += 1) {
          expect(hueDistance(hues[i], hues[j])).toBeGreaterThan(45);
        }
      }
    }
  );

  it("keeps the CutReady palette close to its original hand-picked colours", () => {
    const palette = THEME_PALETTES.find((entry) => entry.id === "cutready")!;

    expect(deriveContentTokens(palette.dark).sketch).toBe("170 160 255");
    // Original light values were 111 99 232 / 15 118 110 / 194 105 17.
    expect(deriveContentTokens(palette.light)).toEqual({
      sketch: "105 94 216",
      storyboard: "7 129 111",
      note: "181 87 0",
    });
  });
});

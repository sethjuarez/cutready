import { describe, expect, it } from "vitest";
import { THEME_PALETTES, deriveContentTokens } from "../theme/appThemePalettes";
import { readFileSync } from "node:fs";
import { MICA_TINTS, sidebarBackdrops } from "../theme/paletteColor";

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
        // Tinted sidebar icons stay visible on the mica sidebar, plain or selected (WCAG 1.4.11).
        for (const backdrop of sidebarBackdrops(colors)) {
          expect(contrastRatio(token, backdrop.join(" "))).toBeGreaterThanOrEqual(3);
        }
      }

      const hues = entries.map(oklchHue);
      for (let i = 0; i < hues.length; i += 1) {
        for (let j = i + 1; j < hues.length; j += 1) {
          expect(hueDistance(hues[i], hues[j])).toBeGreaterThan(45);
        }
      }
    }
  );

  it("keeps the CutReady Warm palette close to its original hand-picked colours", () => {
    const palette = THEME_PALETTES.find((entry) => entry.id === "cutready-warm")!;

    expect(deriveContentTokens(palette.dark).sketch).toBe("170 160 255");
    // Original light values were 111 99 232 / 15 118 110 / 194 105 17; chat is the fourth derived document lane.
    // Storyboard and note are deepened slightly so sidebar icons keep 3:1 on the mica selected row.
    expect(deriveContentTokens(palette.light)).toEqual({
      sketch: "105 94 216",
      storyboard: "10 122 105",
      note: "170 83 3",
      chat: "182 60 143",
    });
  });

  const css = readFileSync("src/index.css", "utf8");
  const block = (selector: string) => css.slice(css.indexOf(`${selector} {`), css.indexOf("}", css.indexOf(`${selector} {`)));

  it.each([[":root", "light"], [".dark", "dark"]] as const)("keeps the %s first-paint fallbacks in sync with the CutReady palette", (selector, mode) => {
    const rules = block(selector);
    const palette = THEME_PALETTES.find((entry) => entry.id === "cutready")!;
    const derived = deriveContentTokens(palette[mode]);
    for (const [key, token] of Object.entries(derived)) {
      expect(rules).toContain(`--color-content-${key}: ${token};`);
    }
    const micaDecl = rules.slice(rules.indexOf("--mica:"));
    const mica = [...micaDecl.slice(0, micaDecl.indexOf(";")).matchAll(/rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/g)];
    expect(mica.map((m) => [[+m[1], +m[2], +m[3]], +m[4]])).toEqual(MICA_TINTS[mode]);
  });
});

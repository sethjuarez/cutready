import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { THEME_PALETTES } from "../theme/appThemePalettes";
import { THEME_COLOR_TOKEN_MAP } from "../theme/applyThemePalette";
import { contrastRatio, deriveNavMuted, tokenToRgb, type Rgb } from "../theme/paletteColor";
import { normalizeDensity } from "../theme/designTokens";

const css = readFileSync(resolve(__dirname, "../index.css"), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const ratio = (a: string, b: string) => contrastRatio(tokenToRgb(a), tokenToRgb(b));

/** Composites a translucent foreground (alpha 0..1) over an opaque background. */
function composite(fg: Rgb, alpha: number, bg: Rgb): string {
  return fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha))).join(" ");
}

const MODES = ["light", "dark"] as const;
const defaults = { light: block(":root"), dark: block(".dark") };

describe("Direction C design tokens", () => {
  it.each(MODES)("index.css %s defaults match the polished CutReady palette", (mode) => {
    const palette = THEME_PALETTES.find((p) => p.id === "cutready")![mode];
    for (const [key, cssVar] of Object.entries(THEME_COLOR_TOKEN_MAP)) {
      expect([cssVar, defaults[mode][cssVar]]).toEqual([cssVar, palette[key as keyof typeof palette]]);
    }
  });

  it.each(THEME_PALETTES.flatMap((p) => MODES.map((m) => [p.id, m] as const)))(
    "%s/%s body and secondary text meet AA on every surface",
    (id, mode) => {
      const c = THEME_PALETTES.find((p) => p.id === id)![mode];
      for (const surface of [c.surface, c.surfaceAlt, c.surfaceInset]) {
        expect(ratio(c.text, surface)).toBeGreaterThanOrEqual(4.5);
        expect(ratio(c.textSecondary, surface)).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each(MODES)("%s agent and diff tokens are legible on their backgrounds", (mode) => {
    const t = defaults[mode];
    const surface = t["--color-surface"];
    for (const agent of ["planner", "writer", "editor", "designer"]) {
      expect(ratio(t[`--color-agent-${agent}`], surface)).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio(t["--color-diff-ins-fg"], t["--color-diff-ins-bg"])).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t["--color-diff-del-fg"], t["--color-diff-del-bg"])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(MODES)("%s text stays AA on hover/selected fills", (mode) => {
    const t = defaults[mode];
    const text = tokenToRgb(t["--color-text"]);
    const surface = tokenToRgb(t["--color-surface"]);
    for (const alpha of [0.04, 0.06, 0.08]) {
      expect(ratio(t["--color-text"], composite(text, alpha, surface))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t["--color-text-secondary"], composite(text, alpha, surface))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(MODES)("index.css %s nav-muted default matches the derived CutReady value", (mode) => {
    const palette = THEME_PALETTES.find((p) => p.id === "cutready")![mode];
    expect(defaults[mode]["--color-nav-muted"]).toBe(deriveNavMuted(palette));
  });

  it.each(THEME_PALETTES.flatMap((p) => MODES.map((m) => [p.id, m] as const)))(
    "%s/%s sidebar text, muted labels and count chip meet AA",
    (id, mode) => {
      const c = THEME_PALETTES.find((p) => p.id === id)![mode];
      const inset = tokenToRgb(c.surfaceInset);
      // --nav-selected and --nav-count-bg from index.css.
      const selected = mode === "light" ? composite([129, 139, 152], 0.15, inset) : composite([101, 108, 118], 0.2, inset);
      const chip = composite(tokenToRgb(c.accent), mode === "light" ? 0.12 : 0.1, tokenToRgb(c.surface));
      expect(ratio(c.text, selected)).toBeGreaterThanOrEqual(4.5);
      for (const surface of [c.surface, c.surfaceAlt, c.surfaceInset]) {
        expect(ratio(deriveNavMuted(c), surface)).toBeGreaterThanOrEqual(4.5);
      }
      expect(ratio(c.text, chip)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("type scale only grows and compact density never shrinks text", () => {
    const root = defaults.light;
    expect(parseFloat(root["--text-2xs"])).toBeGreaterThanOrEqual(11);
    expect(parseFloat(root["--text-xs"])).toBeGreaterThanOrEqual(12.5);
    expect(parseFloat(root["--text-sm"])).toBeGreaterThanOrEqual(14);
    const compact = block('html[data-density="compact"]');
    expect(Object.keys(compact).filter((k) => k.startsWith("--text"))).toEqual([]);
  });

  it("normalizes legacy and unknown density values to comfortable", () => {
    expect(normalizeDensity("compact")).toBe("compact");
    expect(normalizeDensity("spacious")).toBe("comfortable");
    expect(normalizeDensity(undefined)).toBe("comfortable");
  });
});

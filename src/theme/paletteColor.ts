import type { ThemeColorTokens, ThemePalette } from "./appThemePalettes";

export type Rgb = [number, number, number];

export function tokenToRgb(token: string): Rgb {
  const parts = token.split(/\s+/).map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

export function rgbToToken([r, g, b]: Rgb): string {
  return `${Math.round(r)} ${Math.round(g)} ${Math.round(b)}`;
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, value));
}

function mixRgb(from: Rgb, to: Rgb, amount: number): Rgb {
  return [
    clampChannel(from[0] + (to[0] - from[0]) * amount),
    clampChannel(from[1] + (to[1] - from[1]) * amount),
    clampChannel(from[2] + (to[2] - from[2]) * amount),
  ];
}

function linearize(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(linearize) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

function toOklab(rgb: Rgb): Rgb {
  const [r, g, b] = rgb.map(linearize) as Rgb;
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);

  return [
    0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot,
    1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot,
    0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot,
  ];
}

function oklabDistance(a: Rgb, b: Rgb): number {
  const first = toOklab(a);
  const second = toOklab(b);
  return Math.hypot(
    (first[0] - second[0]) * 100,
    (first[1] - second[1]) * 100,
    (first[2] - second[2]) * 100
  );
}

function adjustToward(
  value: Rgb,
  target: Rgb,
  passes: (candidate: Rgb) => boolean,
): Rgb {
  let best = value;

  for (let step = 1; step <= 12; step += 1) {
    const candidate = mixRgb(value, target, step / 12);
    best = candidate;
    if (passes(candidate)) {
      break;
    }
  }

  return best;
}

export function ensureContrast(value: Rgb, background: Rgb, target: Rgb, minimum: number): Rgb {
  if (contrastRatio(value, background) >= minimum) return value;
  return adjustToward(value, target, (candidate) => contrastRatio(candidate, background) >= minimum);
}

function ensureDistance(value: Rgb, reference: Rgb, target: Rgb, minimum: number): Rgb {
  if (oklabDistance(value, reference) >= minimum) return value;
  return adjustToward(value, target, (candidate) => oklabDistance(candidate, reference) >= minimum);
}

function ensureHoverState(value: Rgb, accent: Rgb, surface: Rgb, text: Rgb): Rgb {
  if (contrastRatio(value, surface) >= 4.5 && oklabDistance(value, accent) >= 6) {
    return value;
  }

  const ink: Rgb = [24, 22, 20];
  const paper: Rgb = [255, 255, 255];
  const targets = [text, surface, ink, paper].sort(
    (a, b) => oklabDistance(b, accent) - oklabDistance(a, accent)
  );
  let best = value;
  let bestScore = Math.min(contrastRatio(value, surface) / 4.5, oklabDistance(value, accent) / 6);

  for (const target of targets) {
    for (let step = 1; step <= 16; step += 1) {
      const candidate = mixRgb(value, target, step / 16);
      const contrast = contrastRatio(candidate, surface);
      const distance = oklabDistance(candidate, accent);
      const score = Math.min(contrast / 4.5, distance / 6);

      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }

      if (contrast >= 4.5 && distance >= 6) {
        return candidate;
      }
    }
  }

  return best;
}

function bestAccentForeground(accent: Rgb): string {
  const white: Rgb = [255, 255, 255];
  const ink: Rgb = [24, 22, 20];
  return rgbToToken(contrastRatio(white, accent) >= contrastRatio(ink, accent) ? white : ink);
}

/** The sidebar's selected row: --nav-selected (index.css) over the inset surface. */
export function navSelectedBackground(tokens: ThemeColorTokens): Rgb {
  const inset = tokenToRgb(tokens.surfaceInset);
  return isLightTokens(tokens) ? mixRgb(inset, NAV_SELECTED.light, 0.15) : mixRgb(inset, NAV_SELECTED.dark, 0.2);
}

const NAV_SELECTED: Record<"light" | "dark", Rgb> = { light: [129, 139, 152], dark: [101, 108, 118] };

/** The peak tints of --mica (index.css), which sit over the inset surface behind the sidebar. Keep in sync. */
export const MICA_TINTS: Record<"light" | "dark", Array<[Rgb, number]>> = {
  light: [[[204, 196, 240], 0.62], [[193, 212, 238], 0.5], [[190, 226, 219], 0.5], [[214, 208, 238], 0.4]],
  dark: [[[104, 90, 170], 0.24], [[64, 92, 140], 0.2], [[52, 108, 100], 0.18]],
};

function isLightTokens(tokens: ThemeColorTokens): boolean {
  return relativeLuminance(tokenToRgb(tokens.surface)) > 0.5;
}

/** Everything a sidebar row can sit on: the inset or a mica peak, each plain or selected. */
export function sidebarBackdrops(tokens: ThemeColorTokens): Rgb[] {
  const mode = isLightTokens(tokens) ? "light" : "dark";
  const inset = tokenToRgb(tokens.surfaceInset);
  const plain = [inset, ...MICA_TINTS[mode].map(([tint, alpha]) => mixRgb(inset, tint, alpha))];
  const selectedAlpha = mode === "light" ? 0.15 : 0.2;
  return [...plain, ...plain.map((backdrop) => mixRgb(backdrop, NAV_SELECTED[mode], selectedAlpha))];
}

function polishTokens(tokens: ThemeColorTokens): ThemeColorTokens {
  const surface = tokenToRgb(tokens.surface);
  const isLight = relativeLuminance(surface) > 0.5;
  const navSelected = navSelectedBackground(tokens);

  const surfaces = [tokens.surface, tokens.surfaceAlt, tokens.surfaceInset].map(tokenToRgb);
  const extreme: Rgb = isLight ? [0, 0, 0] : [255, 255, 255];
  // Body and secondary text must stay AA on every surface they sit on, not just the base surface.
  const text = [...surfaces, navSelected].reduce((value, background) => ensureContrast(value, background, extreme, 4.5), tokenToRgb(tokens.text));
  const accentTarget = text;
  const borderTarget = text;

  const accent = ensureContrast(tokenToRgb(tokens.accent), surface, accentTarget, 4.5);
  const accentHover = ensureHoverState(tokenToRgb(tokens.accentHover), accent, surface, text);
  const border = ensureDistance(tokenToRgb(tokens.border), surface, borderTarget, 8);
  const borderSubtle = ensureDistance(tokenToRgb(tokens.borderSubtle), surface, borderTarget, 5);
  const textSecondary = surfaces.reduce(
    (value, background) => ensureContrast(value, background, text, 4.5),
    tokenToRgb(tokens.textSecondary),
  );

  return {
    ...tokens,
    text: rgbToToken(text),
    accent: rgbToToken(accent),
    accentHover: rgbToToken(accentHover),
    border: rgbToToken(border),
    borderSubtle: rgbToToken(borderSubtle),
    textSecondary: rgbToToken(textSecondary),
    accentFg: bestAccentForeground(accent),
  };
}

/**
 * Sidebar section headers, icons and hints. Dark uses text at 60% over the inset (Primer's muted
 * step), raised only as far as AA on every surface requires; light uses the polished secondary.
 */
export function deriveNavMuted(tokens: ThemeColorTokens): string {
  const surfaces = [tokens.surface, tokens.surfaceAlt, tokens.surfaceInset].map(tokenToRgb);
  if (relativeLuminance(surfaces[0]) > 0.5) return tokens.textSecondary;
  const text = tokenToRgb(tokens.text);
  const muted = mixRgb(surfaces[2], text, 0.6);
  return rgbToToken(surfaces.reduce((value, background) => ensureContrast(value, background, text, 4.5), muted));
}

export function polishThemePalette(palette: ThemePalette): ThemePalette {
  return {
    ...palette,
    light: polishTokens(palette.light),
    dark: polishTokens(palette.dark),
  };
}

function fromOklab([lightness, aAxis, bAxis]: Rgb): Rgb {
  const lRoot = lightness + 0.3963377774 * aAxis + 0.2158037573 * bAxis;
  const mRoot = lightness - 0.1055613458 * aAxis - 0.0638541728 * bAxis;
  const sRoot = lightness - 0.0894841775 * aAxis - 1.291485548 * bAxis;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => {
    const encoded = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
    return clampChannel(encoded * 255);
  }) as Rgb;
}

/**
 * Rotates hue in OKLCh so perceived lightness and chroma stay fixed. Rotating in
 * HSL instead would make warm hues read far brighter than cool ones at the same
 * nominal lightness.
 */
function rotateHue(rgb: Rgb, degrees: number, minimumChroma: number): Rgb {
  const [lightness, aAxis, bAxis] = toOklab(rgb);
  const chroma = Math.max(Math.hypot(aAxis, bAxis), minimumChroma);
  const hue = Math.atan2(bAxis, aAxis) + (degrees * Math.PI) / 180;

  return fromOklab([lightness, Math.cos(hue) * chroma, Math.sin(hue) * chroma]);
}

/**
 * Hue offsets from the palette accent, in OKLCh degrees. Measured from the
 * original hand-picked CutReady content colours so the default theme keeps its
 * indigo/teal/amber/rose identity. The offsets keep content types distinguishable
 * in every palette -- unlike reusing
 * `warning`/`success`, which collide with `accent` outright in some palettes.
 */
const CONTENT_HUE_OFFSETS: Record<ContentTypeTokenKey, number> = {
  sketch: 0,
  storyboard: -100,
  note: 145,
  chat: 60,
};

/** Keeps near-greyscale accents (Ink Mono) faintly tinted rather than identical. */
const CONTENT_MINIMUM_CHROMA = 0.06;

export type ContentTypeTokenKey = "storyboard" | "sketch" | "note" | "chat";

export function deriveContentTokens(
  tokens: ThemeColorTokens
): Record<ContentTypeTokenKey, string> {
  const accent = tokenToRgb(tokens.accent);
  const surface = tokenToRgb(tokens.surface);
  const text = tokenToRgb(tokens.text);
  // Sidebar icons tinted with these sit on the mica sidebar, plain or selected; icons need 3:1 (WCAG 1.4.11).
  const iconBackgrounds = sidebarBackdrops(tokens);

  return Object.fromEntries(
    Object.entries(CONTENT_HUE_OFFSETS).map(([key, offset]) => {
      const rotated = rotateHue(accent, offset, CONTENT_MINIMUM_CHROMA);
      const legible = ensureContrast(rotated, surface, text, 4.5);
      return [key, rgbToToken(iconBackgrounds.reduce((value, bg) => ensureContrast(value, bg, text, 3), legible))];
    })
  ) as Record<ContentTypeTokenKey, string>;
}

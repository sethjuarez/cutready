export type ThemePaletteId =
  | "cutready"
  | "abolkog"
  | "soft"
  | "noctis"
  | "github"
  | "fox"
  | "orange"
  | "solarized"
  | "dracula"
  | "nord"
  | "rose"
  | "everforest"
  | "gruvbox"
  | "catppuccin"
  | "mono";

export interface ThemeColorTokens {
  surface: string;
  surfaceAlt: string;
  surfaceInset: string;
  surfaceToolbar: string;
  accent: string;
  accentHover: string;
  border: string;
  borderSubtle: string;
  text: string;
  textSecondary: string;
  secondary: string;
  tertiary: string;
  success: string;
  warning: string;
  error: string;
  accentFg: string;
  overlayScrim: string;
  overlayStrong: string;
  mediaControlBg: string;
  mediaControlFg: string;
}

export interface ThemePalette {
  id: ThemePaletteId;
  name: string;
  description: string;
  swatches: string[];
  light: ThemeColorTokens;
  dark: ThemeColorTokens;
}

type Rgb = [number, number, number];

function tokenToRgb(token: string): Rgb {
  const parts = token.split(/\s+/).map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function rgbToToken([r, g, b]: Rgb): string {
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

function contrastRatio(a: Rgb, b: Rgb): number {
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

function ensureContrast(value: Rgb, background: Rgb, target: Rgb, minimum: number): Rgb {
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

function polishTokens(tokens: ThemeColorTokens): ThemeColorTokens {
  const surface = tokenToRgb(tokens.surface);
  const text = tokenToRgb(tokens.text);
  const accentTarget = text;
  const borderTarget = text;

  const accent = ensureContrast(tokenToRgb(tokens.accent), surface, accentTarget, 4.5);
  const accentHover = ensureHoverState(tokenToRgb(tokens.accentHover), accent, surface, text);
  const border = ensureDistance(tokenToRgb(tokens.border), surface, borderTarget, 8);
  const borderSubtle = ensureDistance(tokenToRgb(tokens.borderSubtle), surface, borderTarget, 5);
  const textSecondary = ensureContrast(tokenToRgb(tokens.textSecondary), surface, text, 4.5);

  return {
    ...tokens,
    accent: rgbToToken(accent),
    accentHover: rgbToToken(accentHover),
    border: rgbToToken(border),
    borderSubtle: rgbToToken(borderSubtle),
    textSecondary: rgbToToken(textSecondary),
    accentFg: bestAccentForeground(accent),
  };
}

function polishThemePalette(palette: ThemePalette): ThemePalette {
  return {
    ...palette,
    light: polishTokens(palette.light),
    dark: polishTokens(palette.dark),
  };
}

const cutreadyLight: ThemeColorTokens = {
  surface: "251 250 248",
  surfaceAlt: "243 240 236",
  surfaceInset: "236 231 225",
  surfaceToolbar: "228 222 214",
  accent: "111 99 232",
  accentHover: "91 79 209",
  border: "222 216 207",
  borderSubtle: "235 229 222",
  text: "44 41 37",
  textSecondary: "112 106 98",
  secondary: "124 58 237",
  tertiary: "219 39 119",
  success: "22 163 74",
  warning: "217 119 6",
  error: "220 38 38",
  accentFg: "255 255 255",
  overlayScrim: "0 0 0",
  overlayStrong: "0 0 0",
  mediaControlBg: "0 0 0",
  mediaControlFg: "255 255 255",
};

const cutreadyDark: ThemeColorTokens = {
  surface: "39 36 33",
  surfaceAlt: "49 45 41",
  surfaceInset: "33 31 29",
  surfaceToolbar: "27 25 23",
  accent: "170 160 255",
  accentHover: "145 133 246",
  border: "73 67 61",
  borderSubtle: "58 53 47",
  text: "238 233 226",
  textSecondary: "180 172 162",
  secondary: "167 139 250",
  tertiary: "244 114 182",
  success: "52 211 153",
  warning: "251 191 36",
  error: "248 113 113",
  accentFg: "255 255 255",
  overlayScrim: "0 0 0",
  overlayStrong: "0 0 0",
  mediaControlBg: "0 0 0",
  mediaControlFg: "255 255 255",
};

const rawThemePalettes: ThemePalette[] = [
  {
    id: "cutready",
    name: "CutReady",
    description: "Warm neutral surfaces with violet accents.",
    swatches: ["#2b2926", "#353230", "#a49afa", "#e8e4df"],
    light: cutreadyLight,
    dark: cutreadyDark,
  },
  {
    id: "abolkog",
    name: "Abolkog",
    description: "Cool charcoal with blue-violet highlights.",
    swatches: ["#1f2630", "#303947", "#8fb7ff", "#dbe3ee"],
    light: {
      ...cutreadyLight,
      surface: "247 249 252",
      surfaceAlt: "232 237 244",
      surfaceInset: "224 230 239",
      surfaceToolbar: "214 222 233",
      accent: "71 101 177",
      accentHover: "55 82 153",
      border: "203 212 225",
      borderSubtle: "219 226 236",
      text: "31 38 48",
      textSecondary: "102 113 128",
    },
    dark: {
      ...cutreadyDark,
      surface: "31 38 48",
      surfaceAlt: "40 49 62",
      surfaceInset: "25 31 40",
      surfaceToolbar: "22 27 35",
      accent: "143 183 255",
      accentHover: "114 162 246",
      border: "62 73 90",
      borderSubtle: "48 57 71",
      text: "219 227 238",
      textSecondary: "150 161 176",
    },
  },
  {
    id: "soft",
    name: "Soft Color",
    description: "Quiet graphite with green and rose cues.",
    swatches: ["#242924", "#3b423b", "#42b883", "#d965c2"],
    light: {
      ...cutreadyLight,
      surface: "248 249 245",
      surfaceAlt: "235 239 231",
      surfaceInset: "226 232 222",
      surfaceToolbar: "216 224 213",
      accent: "62 133 93",
      accentHover: "47 111 75",
      border: "211 220 207",
      borderSubtle: "225 231 222",
      text: "35 43 35",
      textSecondary: "104 119 105",
      tertiary: "197 83 170",
    },
    dark: {
      ...cutreadyDark,
      surface: "36 41 36",
      surfaceAlt: "47 55 48",
      surfaceInset: "30 35 31",
      surfaceToolbar: "25 30 26",
      accent: "80 190 132",
      accentHover: "65 169 113",
      border: "62 72 62",
      borderSubtle: "50 59 51",
      text: "224 231 222",
      textSecondary: "149 160 147",
      tertiary: "217 101 194",
    },
  },
  {
    id: "noctis",
    name: "Noctis Hibernus",
    description: "Deep indigo surfaces with mint accents.",
    swatches: ["#272542", "#37345a", "#63d99a", "#e67caf"],
    light: {
      ...cutreadyLight,
      surface: "249 248 255",
      surfaceAlt: "236 233 250",
      surfaceInset: "228 224 244",
      surfaceToolbar: "218 213 236",
      accent: "94 85 179",
      accentHover: "76 67 153",
      border: "211 206 231",
      borderSubtle: "226 222 240",
      text: "45 42 73",
      textSecondary: "111 106 137",
      success: "47 166 105",
      tertiary: "213 101 154",
    },
    dark: {
      ...cutreadyDark,
      surface: "39 37 66",
      surfaceAlt: "51 48 86",
      surfaceInset: "32 30 55",
      surfaceToolbar: "28 26 47",
      accent: "177 146 255",
      accentHover: "154 123 239",
      border: "72 67 111",
      borderSubtle: "57 53 92",
      text: "231 226 248",
      textSecondary: "164 158 190",
      success: "99 217 154",
      tertiary: "230 124 175",
    },
  },
  {
    id: "github",
    name: "GitHub",
    description: "Slate editor tones with blue accents.",
    swatches: ["#24292f", "#30363d", "#58a6ff", "#f0f6fc"],
    light: {
      ...cutreadyLight,
      surface: "246 248 250",
      surfaceAlt: "234 238 242",
      surfaceInset: "225 230 236",
      surfaceToolbar: "216 222 229",
      accent: "9 105 218",
      accentHover: "5 80 174",
      border: "208 215 222",
      borderSubtle: "221 226 232",
      text: "36 41 47",
      textSecondary: "87 96 106",
    },
    dark: {
      ...cutreadyDark,
      surface: "36 41 47",
      surfaceAlt: "48 54 61",
      surfaceInset: "29 34 40",
      surfaceToolbar: "22 27 34",
      accent: "88 166 255",
      accentHover: "56 139 253",
      border: "68 76 86",
      borderSubtle: "54 62 72",
      text: "240 246 252",
      textSecondary: "139 148 158",
    },
  },
  {
    id: "fox",
    name: "Fox",
    description: "Blue-black surfaces with lilac accents.",
    swatches: ["#172033", "#24314a", "#b088ff", "#8bd5ca"],
    light: {
      ...cutreadyLight,
      surface: "246 249 253",
      surfaceAlt: "229 236 247",
      surfaceInset: "219 228 242",
      surfaceToolbar: "209 220 236",
      accent: "97 91 202",
      accentHover: "79 72 178",
      border: "202 214 232",
      borderSubtle: "219 228 241",
      text: "23 32 51",
      textSecondary: "94 108 130",
      success: "63 159 147",
    },
    dark: {
      ...cutreadyDark,
      surface: "23 32 51",
      surfaceAlt: "33 45 68",
      surfaceInset: "18 26 42",
      surfaceToolbar: "15 22 36",
      accent: "176 136 255",
      accentHover: "153 113 238",
      border: "53 68 95",
      borderSubtle: "41 55 79",
      text: "226 235 248",
      textSecondary: "145 160 184",
      success: "139 213 202",
    },
  },
  {
    id: "orange",
    name: "IC Orange PPL",
    description: "Earthy charcoal with orange emphasis.",
    swatches: ["#2e2b25", "#443d31", "#ff6a1a", "#a6b90f"],
    light: {
      ...cutreadyLight,
      surface: "250 247 241",
      surfaceAlt: "239 232 219",
      surfaceInset: "230 220 203",
      surfaceToolbar: "221 209 190",
      accent: "201 82 19",
      accentHover: "166 63 12",
      border: "218 205 186",
      borderSubtle: "231 221 205",
      text: "48 42 33",
      textSecondary: "124 111 91",
      secondary: "137 151 20",
      tertiary: "148 92 210",
    },
    dark: {
      ...cutreadyDark,
      surface: "46 43 37",
      surfaceAlt: "62 55 44",
      surfaceInset: "37 34 29",
      surfaceToolbar: "31 28 24",
      accent: "255 106 26",
      accentHover: "231 84 13",
      border: "78 68 53",
      borderSubtle: "61 54 44",
      text: "237 229 214",
      textSecondary: "169 155 130",
      secondary: "166 185 15",
      tertiary: "185 130 245",
    },
  },
  {
    id: "solarized",
    name: "Solarized",
    description: "Low-contrast editorial cyan and amber.",
    swatches: ["#002b36", "#073642", "#2aa198", "#b58900"],
    light: {
      ...cutreadyLight,
      surface: "253 246 227",
      surfaceAlt: "238 232 213",
      surfaceInset: "230 223 202",
      surfaceToolbar: "221 214 193",
      accent: "38 139 210",
      accentHover: "29 117 178",
      border: "214 205 180",
      borderSubtle: "228 219 196",
      text: "88 110 117",
      textSecondary: "101 123 131",
      secondary: "42 161 152",
      tertiary: "181 137 0",
    },
    dark: {
      ...cutreadyDark,
      surface: "0 43 54",
      surfaceAlt: "7 54 66",
      surfaceInset: "0 34 43",
      surfaceToolbar: "0 30 38",
      accent: "42 161 152",
      accentHover: "32 136 128",
      border: "35 83 94",
      borderSubtle: "18 67 79",
      text: "238 232 213",
      textSecondary: "147 161 161",
      secondary: "38 139 210",
      tertiary: "181 137 0",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    description: "High-contrast violet with neon accents.",
    swatches: ["#282a36", "#44475a", "#bd93f9", "#50fa7b"],
    light: {
      ...cutreadyLight,
      surface: "249 247 255",
      surfaceAlt: "235 231 247",
      surfaceInset: "226 221 241",
      surfaceToolbar: "216 210 233",
      accent: "120 82 190",
      accentHover: "96 65 163",
      border: "211 203 231",
      borderSubtle: "226 220 240",
      text: "45 42 57",
      textSecondary: "109 101 130",
      success: "45 166 88",
      tertiary: "198 68 130",
    },
    dark: {
      ...cutreadyDark,
      surface: "40 42 54",
      surfaceAlt: "54 57 73",
      surfaceInset: "32 34 45",
      surfaceToolbar: "28 30 40",
      accent: "189 147 249",
      accentHover: "169 124 236",
      border: "68 71 90",
      borderSubtle: "55 58 74",
      text: "248 248 242",
      textSecondary: "183 185 205",
      success: "80 250 123",
      tertiary: "255 121 198",
    },
  },
  {
    id: "nord",
    name: "Nord",
    description: "Arctic blue-grey with calm frost accents.",
    swatches: ["#2e3440", "#3b4252", "#88c0d0", "#a3be8c"],
    light: {
      ...cutreadyLight,
      surface: "236 239 244",
      surfaceAlt: "229 233 240",
      surfaceInset: "216 222 233",
      surfaceToolbar: "209 216 227",
      accent: "94 129 172",
      accentHover: "76 107 148",
      border: "199 207 221",
      borderSubtle: "215 221 231",
      text: "46 52 64",
      textSecondary: "94 103 121",
      success: "91 137 96",
      tertiary: "180 142 173",
    },
    dark: {
      ...cutreadyDark,
      surface: "46 52 64",
      surfaceAlt: "59 66 82",
      surfaceInset: "38 43 53",
      surfaceToolbar: "33 37 46",
      accent: "136 192 208",
      accentHover: "129 161 193",
      border: "76 86 106",
      borderSubtle: "62 70 87",
      text: "236 239 244",
      textSecondary: "180 190 205",
      success: "163 190 140",
      tertiary: "180 142 173",
    },
  },
  {
    id: "rose",
    name: "Rose Pine",
    description: "Muted rose, pine, and gold tones.",
    swatches: ["#191724", "#26233a", "#ebbcba", "#f6c177"],
    light: {
      ...cutreadyLight,
      surface: "250 244 237",
      surfaceAlt: "242 233 224",
      surfaceInset: "234 222 214",
      surfaceToolbar: "225 213 205",
      accent: "144 122 169",
      accentHover: "117 98 143",
      border: "218 205 196",
      borderSubtle: "232 220 211",
      text: "87 82 121",
      textSecondary: "121 117 147",
      secondary: "86 148 159",
      tertiary: "210 129 139",
    },
    dark: {
      ...cutreadyDark,
      surface: "25 23 36",
      surfaceAlt: "38 35 58",
      surfaceInset: "20 18 30",
      surfaceToolbar: "16 15 24",
      accent: "235 188 186",
      accentHover: "221 167 166",
      border: "64 61 82",
      borderSubtle: "48 45 66",
      text: "224 222 244",
      textSecondary: "144 140 170",
      secondary: "156 207 216",
      tertiary: "246 193 119",
    },
  },
  {
    id: "everforest",
    name: "Everforest",
    description: "Forest greens with warm yellow accents.",
    swatches: ["#2d353b", "#3d484d", "#a7c080", "#dbbc7f"],
    light: {
      ...cutreadyLight,
      surface: "253 245 215",
      surfaceAlt: "242 232 199",
      surfaceInset: "232 220 187",
      surfaceToolbar: "223 210 176",
      accent: "95 143 86",
      accentHover: "76 121 69",
      border: "214 200 166",
      borderSubtle: "229 217 184",
      text: "77 82 79",
      textSecondary: "122 132 120",
      secondary: "53 137 136",
      tertiary: "196 101 74",
    },
    dark: {
      ...cutreadyDark,
      surface: "45 53 59",
      surfaceAlt: "61 72 77",
      surfaceInset: "39 46 51",
      surfaceToolbar: "35 41 46",
      accent: "167 192 128",
      accentHover: "139 172 103",
      border: "75 88 92",
      borderSubtle: "62 73 78",
      text: "211 198 170",
      textSecondary: "154 164 143",
      secondary: "131 192 146",
      tertiary: "219 188 127",
    },
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    description: "Warm retro browns with practical yellow accents.",
    swatches: ["#282828", "#3c3836", "#fabd2f", "#83a598"],
    light: {
      ...cutreadyLight,
      surface: "251 241 199",
      surfaceAlt: "235 219 178",
      surfaceInset: "224 204 157",
      surfaceToolbar: "213 196 161",
      accent: "181 118 20",
      accentHover: "151 92 11",
      border: "205 184 142",
      borderSubtle: "222 205 166",
      text: "60 56 54",
      textSecondary: "124 111 100",
      secondary: "69 133 136",
      tertiary: "177 98 134",
      success: "121 116 14",
      warning: "181 118 20",
      error: "157 0 6",
    },
    dark: {
      ...cutreadyDark,
      surface: "40 40 40",
      surfaceAlt: "60 56 54",
      surfaceInset: "29 32 33",
      surfaceToolbar: "24 26 27",
      accent: "250 189 47",
      accentHover: "215 153 33",
      border: "80 73 69",
      borderSubtle: "66 60 57",
      text: "235 219 178",
      textSecondary: "168 153 132",
      secondary: "131 165 152",
      tertiary: "211 134 155",
      success: "184 187 38",
      warning: "250 189 47",
      error: "251 73 52",
      accentFg: "40 40 40",
    },
  },
  {
    id: "catppuccin",
    name: "Catppuccin",
    description: "Soft lavender surfaces with peach and teal cues.",
    swatches: ["#1e1e2e", "#313244", "#cba6f7", "#fab387"],
    light: {
      ...cutreadyLight,
      surface: "239 241 245",
      surfaceAlt: "230 233 239",
      surfaceInset: "220 224 232",
      surfaceToolbar: "204 209 220",
      accent: "136 57 239",
      accentHover: "114 45 207",
      border: "188 192 204",
      borderSubtle: "204 208 219",
      text: "76 79 105",
      textSecondary: "108 111 133",
      secondary: "23 146 153",
      tertiary: "230 69 83",
      success: "64 160 43",
      warning: "223 142 29",
      error: "210 15 57",
    },
    dark: {
      ...cutreadyDark,
      surface: "30 30 46",
      surfaceAlt: "49 50 68",
      surfaceInset: "24 24 37",
      surfaceToolbar: "17 17 27",
      accent: "203 166 247",
      accentHover: "180 132 239",
      border: "69 71 90",
      borderSubtle: "57 58 75",
      text: "205 214 244",
      textSecondary: "166 173 200",
      secondary: "148 226 213",
      tertiary: "250 179 135",
      success: "166 227 161",
      warning: "249 226 175",
      error: "243 139 168",
    },
  },
  {
    id: "mono",
    name: "Ink Mono",
    description: "Restrained monochrome with one crisp accent.",
    swatches: ["#111111", "#2a2a2a", "#d8d8d8", "#8f8f8f"],
    light: {
      ...cutreadyLight,
      surface: "250 250 249",
      surfaceAlt: "238 238 236",
      surfaceInset: "229 229 226",
      surfaceToolbar: "219 219 216",
      accent: "37 37 37",
      accentHover: "17 17 17",
      border: "210 210 207",
      borderSubtle: "226 226 223",
      text: "24 24 23",
      textSecondary: "110 110 106",
      secondary: "85 85 82",
      tertiary: "130 130 126",
    },
    dark: {
      ...cutreadyDark,
      surface: "17 17 17",
      surfaceAlt: "32 32 31",
      surfaceInset: "12 12 12",
      surfaceToolbar: "8 8 8",
      accent: "216 216 216",
      accentHover: "238 238 238",
      border: "58 58 56",
      borderSubtle: "42 42 41",
      text: "238 238 236",
      textSecondary: "150 150 146",
      secondary: "190 190 186",
      tertiary: "170 170 166",
      accentFg: "17 17 17",
    },
  },
];

export const THEME_PALETTES: ThemePalette[] = rawThemePalettes.map(polishThemePalette);

export function getThemePalette(id: string): ThemePalette {
  return THEME_PALETTES.find((palette) => palette.id === id) ?? THEME_PALETTES[0];
}

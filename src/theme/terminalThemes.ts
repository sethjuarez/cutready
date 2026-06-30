export type TerminalColorMode = "console" | "app" | "solarized-dark" | "monokai" | "github-dark" | "custom";

export interface TerminalCustomTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
}

export interface TerminalTheme extends TerminalCustomTheme {
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

export const DEFAULT_TERMINAL_CUSTOM_THEME: TerminalCustomTheme = {
  background: "#0c0c0c",
  foreground: "#cccccc",
  cursor: "#ffffff",
  selectionBackground: "#3a3d41",
};

export const TERMINAL_COLOR_SCHEMES: Array<{
  id: TerminalColorMode;
  label: string;
  description: string;
}> = [
  { id: "console", label: "Console dark", description: "Windows Console defaults" },
  { id: "app", label: "App surface", description: "Follows the active CutReady palette" },
  { id: "solarized-dark", label: "Solarized dark", description: "Low-contrast blue-green terminal palette" },
  { id: "monokai", label: "Monokai", description: "Warm high-contrast editor-inspired colors" },
  { id: "github-dark", label: "GitHub dark", description: "Neutral dark palette with GitHub-style accents" },
  { id: "custom", label: "Custom", description: "Choose foreground, background, cursor, and selection" },
];

const CONSOLE_THEME: TerminalTheme = {
  background: "#0c0c0c",
  foreground: "#cccccc",
  cursor: "#ffffff",
  selectionBackground: "#3a3d41",
  black: "#0c0c0c",
  red: "#c50f1f",
  green: "#13a10e",
  yellow: "#c19c00",
  blue: "#0037da",
  magenta: "#881798",
  cyan: "#3a96dd",
  white: "#cccccc",
  brightBlack: "#767676",
  brightRed: "#e74856",
  brightGreen: "#16c60c",
  brightYellow: "#f9f1a5",
  brightBlue: "#3b78ff",
  brightMagenta: "#b4009e",
  brightCyan: "#61d6d6",
  brightWhite: "#f2f2f2",
};

const SOLARIZED_DARK_THEME: TerminalTheme = {
  background: "#002b36",
  foreground: "#839496",
  cursor: "#93a1a1",
  selectionBackground: "#073642",
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#586e75",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

const MONOKAI_THEME: TerminalTheme = {
  background: "#272822",
  foreground: "#f8f8f2",
  cursor: "#f8f8f0",
  selectionBackground: "#49483e",
  black: "#272822",
  red: "#f92672",
  green: "#a6e22e",
  yellow: "#f4bf75",
  blue: "#66d9ef",
  magenta: "#ae81ff",
  cyan: "#a1efe4",
  white: "#f8f8f2",
  brightBlack: "#75715e",
  brightRed: "#f92672",
  brightGreen: "#a6e22e",
  brightYellow: "#f4bf75",
  brightBlue: "#66d9ef",
  brightMagenta: "#ae81ff",
  brightCyan: "#a1efe4",
  brightWhite: "#f9f8f5",
};

const GITHUB_DARK_THEME: TerminalTheme = {
  background: "#0d1117",
  foreground: "#c9d1d9",
  cursor: "#58a6ff",
  selectionBackground: "#264f78",
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function normalizeTerminalColorMode(value: unknown): TerminalColorMode {
  return TERMINAL_COLOR_SCHEMES.some((scheme) => scheme.id === value) ? value as TerminalColorMode : "console";
}

function normalizeHexColor(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value) ? value : fallback;
}

export function normalizeTerminalCustomTheme(value: unknown): TerminalCustomTheme {
  const input = value && typeof value === "object" ? value as Partial<TerminalCustomTheme> : {};
  return {
    background: normalizeHexColor(input.background, DEFAULT_TERMINAL_CUSTOM_THEME.background),
    foreground: normalizeHexColor(input.foreground, DEFAULT_TERMINAL_CUSTOM_THEME.foreground),
    cursor: normalizeHexColor(input.cursor, DEFAULT_TERMINAL_CUSTOM_THEME.cursor),
    selectionBackground: normalizeHexColor(input.selectionBackground, DEFAULT_TERMINAL_CUSTOM_THEME.selectionBackground),
  };
}

export function resolveTerminalTheme(
  mode: unknown,
  customTheme: unknown,
  readAppColor: (name: string, fallback: string) => string,
): TerminalTheme {
  switch (normalizeTerminalColorMode(mode)) {
    case "app":
      return {
        background: readAppColor("--color-surface-inset", "#1f1d1a"),
        foreground: readAppColor("--color-text", "#f5f1ea"),
        cursor: readAppColor("--color-accent", "#a49afa"),
        selectionBackground: readAppColor("--color-accent", "#6b5ce7"),
      };
    case "solarized-dark":
      return SOLARIZED_DARK_THEME;
    case "monokai":
      return MONOKAI_THEME;
    case "github-dark":
      return GITHUB_DARK_THEME;
    case "custom":
      return { ...CONSOLE_THEME, ...normalizeTerminalCustomTheme(customTheme) };
    case "console":
      return CONSOLE_THEME;
  }
}

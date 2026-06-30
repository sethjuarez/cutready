import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_CUSTOM_THEME,
  normalizeTerminalColorMode,
  normalizeTerminalCustomTheme,
  resolveTerminalTheme,
} from "../theme/terminalThemes";

const appColor = (name: string, fallback: string) => `${name}:${fallback}`;

describe("terminalThemes", () => {
  it("keeps existing console and app modes valid", () => {
    expect(normalizeTerminalColorMode("console")).toBe("console");
    expect(normalizeTerminalColorMode("app")).toBe("app");
  });

  it("falls back unknown persisted modes to console", () => {
    expect(normalizeTerminalColorMode("unknown")).toBe("console");
    expect(resolveTerminalTheme("unknown", null, appColor).background).toBe("#0c0c0c");
  });

  it("resolves predefined terminal schemes", () => {
    expect(resolveTerminalTheme("solarized-dark", null, appColor).background).toBe("#002b36");
    expect(resolveTerminalTheme("monokai", null, appColor).red).toBe("#f92672");
    expect(resolveTerminalTheme("github-dark", null, appColor).brightBlue).toBe("#79c0ff");
  });

  it("uses app tokens for app surface mode", () => {
    const theme = resolveTerminalTheme("app", null, appColor);

    expect(theme.background).toBe("--color-surface-inset:#1f1d1a");
    expect(theme.cursor).toBe("--color-accent:#a49afa");
  });

  it("normalizes custom terminal colors", () => {
    expect(normalizeTerminalCustomTheme({
      background: "#123456",
      foreground: "not-a-color",
      cursor: "#abcdef",
      selectionBackground: "#654321",
    })).toEqual({
      ...DEFAULT_TERMINAL_CUSTOM_THEME,
      background: "#123456",
      cursor: "#abcdef",
      selectionBackground: "#654321",
    });
  });

  it("applies custom colors over the console ANSI palette", () => {
    const theme = resolveTerminalTheme("custom", {
      background: "#111111",
      foreground: "#eeeeee",
      cursor: "#ff00ff",
      selectionBackground: "#333333",
    }, appColor);

    expect(theme.background).toBe("#111111");
    expect(theme.foreground).toBe("#eeeeee");
    expect(theme.cursor).toBe("#ff00ff");
    expect(theme.selectionBackground).toBe("#333333");
    expect(theme.blue).toBe("#0037da");
  });
});

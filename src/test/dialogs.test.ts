import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = join(__dirname, "..");
const allowed = new Set(["dialogs.ts"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" || name === "contracts" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("native dialogs", () => {
  it("are only imported through src/dialogs.ts so drills can answer them", () => {
    const offenders = sourceFiles(srcRoot)
      .map((path) => relative(srcRoot, path).split(sep).join("/"))
      .filter((path) => !allowed.has(path))
      .filter((path) => readFileSync(join(srcRoot, path), "utf8").includes("@tauri-apps/plugin-dialog"));
    expect(offenders).toEqual([]);
  });
});

// Shared setup for the canvas tests: the real `cutready-cli` debug binary
// (build it with `cargo build -p cutready-cli`) and temp git projects.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const canvasRoot = path.join(repoRoot, "extensions", "cutready-canvas");

export function cliBinary() {
    const exe = process.platform === "win32" ? "cutready-cli.exe" : "cutready-cli";
    const target = process.env.CARGO_TARGET_DIR ?? path.join(repoRoot, "target");
    const binary = path.join(target, "debug", exe);
    if (!existsSync(binary)) {
        throw new Error(`${binary} is missing; run \`cargo build -p cutready-cli\` first`);
    }
    return binary;
}

export function tempDir(prefix = "cutready-canvas-") {
    const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A temp folder that is its own git repository, like a standalone project. */
export function tempProject() {
    const temp = tempDir("cutready-project-");
    execFileSync("git", ["init", "-q", temp.dir], { stdio: "ignore" });
    return temp;
}

export function write(root, rel, content) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
}

export const SKETCH = JSON.stringify({
    title: "Intro",
    description: null,
    rows: [],
    state: "draft",
    created_at: "2026-06-28T20:00:00Z",
    updated_at: "2026-06-28T20:00:00Z",
});

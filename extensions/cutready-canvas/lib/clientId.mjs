// The canvas's stable MCP client id. `cutready-cli mcp` records runs as actor
// `mcp:<clientId>` and lets the same id review them after a restart, so it is
// kept per user under `$COPILOT_HOME/extensions/cutready-canvas/artifacts/`.
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function artifactsDir(env = process.env) {
    const copilotHome = env.COPILOT_HOME || path.join(homedir(), ".copilot");
    return path.join(copilotHome, "extensions", "cutready-canvas", "artifacts");
}

function readId(file) {
    try {
        const id = readFileSync(file, "utf8").trim();
        return CLIENT_ID_PATTERN.test(id) ? id : null;
    } catch (err) {
        if (err.code === "ENOENT") return undefined;
        throw err;
    }
}

// Exclusive create, so racing canvas processes all settle on the first id.
export function loadClientId(dir = artifactsDir()) {
    const file = path.join(dir, "client-id");
    mkdirSync(dir, { recursive: true });
    for (let attempt = 0; attempt < 50; attempt++) {
        const existing = readId(file);
        if (existing) return existing;
        if (existing === null) {
            // Unreadable id (e.g. a writer mid-flush, or corruption). Give a
            // concurrent writer a moment before replacing it.
            if (attempt < 5) {
                sleep(20);
                continue;
            }
            rmSync(file, { force: true });
        }
        const id = `canvas-${randomUUID()}`;
        try {
            const fd = openSync(file, "wx");
            try {
                writeSync(fd, `${id}\n`);
            } finally {
                closeSync(fd);
            }
            return id;
        } catch (err) {
            if (err.code !== "EEXIST" && err.code !== "EPERM") throw err;
            sleep(10);
        }
    }
    throw new Error(`Couldn't settle the canvas client id in ${file}`);
}

function sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

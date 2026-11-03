// Smoke test for the app-bundled sidecar: a `cutready-cli` installed where the
// CutReady app puts it registers itself the way the app does on start, and
// the canvas then discovers and handshakes with it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CONTRACT_VERSION } from "../../cutready-canvas/lib/contract.mjs";
import { discoverCli } from "../../cutready-canvas/lib/discovery.mjs";
import { McpClient } from "../../cutready-canvas/lib/mcpClient.mjs";
import { cliBinary, tempDir, tempProject } from "./helpers.mjs";

const exe = process.platform === "win32" ? "cutready-cli.exe" : "cutready-cli";

function installSidecar(root) {
    const dir = path.join(root, "CutReady");
    mkdirSync(dir, { recursive: true });
    const sidecar = path.join(dir, exe);
    copyFileSync(cliBinary(), sidecar);
    return sidecar;
}

async function handshake(cliPath) {
    const project = tempProject();
    const client = await McpClient.start({ cliPath, project: project.dir, clientId: "sidecar-smoke" });
    try {
        assert.equal(client.serverInfo.name, "cutready");
    } finally {
        client.close();
        project.cleanup();
    }
}

test("a registered bundled sidecar is discovered and handshakes", async () => {
    const install = tempDir("cutready-install-");
    const config = tempDir("cutready-config-");
    try {
        const sidecar = installSidecar(install.dir);
        const env = { CUTREADY_CONFIG_DIR: config.dir };
        const output = JSON.parse(
            execFileSync(sidecar, ["register"], { env: { ...process.env, ...env }, encoding: "utf8" }),
        );
        assert.equal(output.registered.path, sidecar);
        assert.equal(output.registered.contract_version, CONTRACT_VERSION);

        const again = JSON.parse(
            execFileSync(sidecar, ["register"], { env: { ...process.env, ...env }, encoding: "utf8" }),
        );
        assert.equal(again.outcome, "replaced", "registering on every start is idempotent");
        assert.deepEqual(JSON.parse(readFileSync(path.join(config.dir, "cli.json"), "utf8")), output.registered);

        const found = discoverCli({ env });
        assert.equal(found.source, "registration");
        assert.equal(found.path, sidecar);
        await handshake(found.path);
    } finally {
        install.cleanup();
        config.cleanup();
    }
});

test(
    "without a registration the per-user Windows install is found and handshakes",
    { skip: process.platform !== "win32" && "per-user install paths are Windows only" },
    async () => {
        const install = tempDir("cutready-install-");
        const config = tempDir("cutready-config-");
        try {
            const sidecar = installSidecar(install.dir);
            const found = discoverCli({ env: { CUTREADY_CONFIG_DIR: config.dir, LOCALAPPDATA: install.dir } });
            assert.deepEqual(found, { path: sidecar, source: "bundled" });
            await handshake(found.path);
        } finally {
            install.cleanup();
            config.cleanup();
        }
    },
);

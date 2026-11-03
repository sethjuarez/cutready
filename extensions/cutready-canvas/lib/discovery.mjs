// Finds the `cutready-cli` binary the canvas starts as `cutready-cli mcp`.
//
// Order (first hit wins; the caller then runs the live handshake, and a
// failed handshake is never retried with another candidate):
//   1. an explicit path: the canvas's `cliPath` open input, else `CUTREADY_CLI`
//   2. the per-user registration `<config dir>/cutready/cli.json` written by
//      `cutready-cli register` (the CutReady app registers its bundled copy)
//   3. the default install locations of the CutReady app's bundled sidecar
//
// An explicit path that doesn't exist, an unreadable registration, or a
// registration for another contract version fails closed. A registration
// whose binary is gone (an uninstalled app) falls through.
import { existsSync, readFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import path from "node:path";
import { CANVAS_ERRORS, CONTRACT_VERSION } from "./contract.mjs";
import { CutReadyError } from "./errors.mjs";

export const REGISTRY_FILE = "cli.json";
export const DIR_ENV = "CUTREADY_CONFIG_DIR";
export const CLI_ENV = "CUTREADY_CLI";

function exeName(platform) {
    return platform === "win32" ? "cutready-cli.exe" : "cutready-cli";
}

// Mirrors `discovery::default_dir` (Rust `dirs::config_dir()/cutready`).
export function registrationDir({ env = process.env, platform = process.platform, homedir = osHomedir() } = {}) {
    if (env[DIR_ENV]) return env[DIR_ENV];
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    if (platform === "win32") {
        return env.APPDATA ? pathApi.join(env.APPDATA, "cutready") : undefined;
    }
    if (platform === "darwin") {
        return pathApi.join(homedir, "Library", "Application Support", "cutready");
    }
    const xdg = env.XDG_CONFIG_HOME && pathApi.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : undefined;
    return pathApi.join(xdg ?? pathApi.join(homedir, ".config"), "cutready");
}

// Where the CutReady app installs its bundled `cutready-cli` sidecar.
export function bundledPaths({ env = process.env, platform = process.platform, homedir = osHomedir() } = {}) {
    const exe = exeName(platform);
    if (platform === "win32") {
        const roots = [env.LOCALAPPDATA, env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean);
        return roots.map((root) => path.win32.join(root, "CutReady", exe));
    }
    if (platform === "darwin") {
        return [
            path.posix.join("/Applications/CutReady.app/Contents/MacOS", exe),
            path.posix.join(homedir, "Applications/CutReady.app/Contents/MacOS", exe),
        ];
    }
    return [path.posix.join("/usr/bin", exe), path.posix.join("/usr/local/bin", exe)];
}

function readRegistration(file, readFile) {
    let text;
    try {
        text = readFile(file);
    } catch (err) {
        if (err && err.code === "ENOENT") return undefined;
        throw new CutReadyError(CANVAS_ERRORS.CLI_NOT_FOUND, `Can't read ${file}: ${err.message}`);
    }
    let install;
    try {
        install = JSON.parse(text);
    } catch {
        throw new CutReadyError(CANVAS_ERRORS.CLI_NOT_FOUND, `${file} isn't valid JSON; run \`cutready-cli register --force\``);
    }
    if (
        !install ||
        typeof install.path !== "string" ||
        !install.path ||
        typeof install.version !== "string" ||
        !install.version ||
        !Number.isInteger(install.contract_version) ||
        install.contract_version < 0 ||
        install.contract_version > 0xffffffff
    ) {
        throw new CutReadyError(CANVAS_ERRORS.CLI_NOT_FOUND, `${file} isn't a CliInstall; run \`cutready-cli register --force\``);
    }
    return install;
}

/**
 * Picks the binary to start. Returns `{ path, source, version? }` where
 * `source` is "explicit", "env", "registration" or "bundled".
 */
export function discoverCli({
    cliPath,
    env = process.env,
    platform = process.platform,
    homedir = osHomedir(),
    exists = existsSync,
    readFile = (file) => readFileSync(file, "utf8"),
    contractVersion = CONTRACT_VERSION,
} = {}) {
    const explicit = cliPath ? { path: cliPath, source: "explicit" } : env[CLI_ENV] ? { path: env[CLI_ENV], source: "env" } : undefined;
    if (explicit) {
        if (!exists(explicit.path)) {
            const from = explicit.source === "env" ? CLI_ENV : "cliPath";
            throw new CutReadyError(CANVAS_ERRORS.CLI_NOT_FOUND, `${from} points at ${explicit.path}, which doesn't exist`);
        }
        return explicit;
    }

    const tried = [];
    const dir = registrationDir({ env, platform, homedir });
    if (dir) {
        const file = (platform === "win32" ? path.win32 : path.posix).join(dir, REGISTRY_FILE);
        const install = readRegistration(file, readFile);
        if (install) {
            if (install.contract_version !== contractVersion) {
                throw new CutReadyError(
                    CANVAS_ERRORS.CONTRACT_MISMATCH,
                    `The registered cutready-cli ${install.version} speaks edit contract ${install.contract_version}; this canvas speaks ${contractVersion}. Update CutReady or the canvas so they match.`,
                    { registered: install.contract_version, canvas: contractVersion, path: install.path },
                );
            }
            // A registration is the user's choice; like discovery.rs, a missing
            // binary fails rather than silently starting another install.
            if (!exists(install.path)) {
                throw new CutReadyError(
                    CANVAS_ERRORS.CLI_NOT_FOUND,
                    `The registered cutready-cli at ${install.path} is missing; start CutReady or run \`cutready-cli register --force\``,
                    { tried: [install.path] },
                );
            }
            return { path: install.path, source: "registration", version: install.version };
        } else {
            tried.push(`${file} (no registration)`);
        }
    }

    for (const candidate of bundledPaths({ env, platform, homedir })) {
        if (exists(candidate)) return { path: candidate, source: "bundled" };
        tried.push(candidate);
    }

    throw new CutReadyError(
        CANVAS_ERRORS.CLI_NOT_FOUND,
        "No cutready-cli found. Install or start the CutReady app (it registers its CLI), run `cutready-cli register`, or open the canvas with `cliPath`.",
        { tried },
    );
}

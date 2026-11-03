import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { bundledPaths, discoverCli, registrationDir } from "../../cutready-canvas/lib/discovery.mjs";

const HOME = "/home/me";
const REG_DIR = "/cfg";
const REG_FILE = path.posix.join(REG_DIR, "cli.json");

function fakeFs(files) {
    return {
        exists: (file) => file in files,
        readFile: (file) => {
            if (!(file in files)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
            return files[file];
        },
    };
}

function discover(files, { env = {}, cliPath } = {}) {
    return discoverCli({
        cliPath,
        env: { CUTREADY_CONFIG_DIR: REG_DIR, ...env },
        platform: "linux",
        homedir: HOME,
        ...fakeFs(files),
    });
}

const registration = (install) => JSON.stringify({ path: "/opt/cli", version: "1.0.0", contract_version: 1, ...install });

test("an explicit cliPath wins, and a missing one fails closed", () => {
    const files = { "/x/cli": "", [REG_FILE]: registration(), "/opt/cli": "" };
    assert.deepEqual(discover(files, { cliPath: "/x/cli" }), { path: "/x/cli", source: "explicit" });
    assert.throws(() => discover(files, { cliPath: "/nope" }), { code: "cli_not_found" });
});

test("CUTREADY_CLI comes next, and a missing one fails closed", () => {
    const files = { "/e/cli": "", [REG_FILE]: registration(), "/opt/cli": "" };
    assert.deepEqual(discover(files, { env: { CUTREADY_CLI: "/e/cli" } }), { path: "/e/cli", source: "env" });
    assert.throws(() => discover(files, { env: { CUTREADY_CLI: "/nope" } }), { code: "cli_not_found" });
});

test("the per-user registration is used when its binary exists", () => {
    const found = discover({ [REG_FILE]: registration(), "/opt/cli": "" });
    assert.deepEqual(found, { path: "/opt/cli", source: "registration", version: "1.0.0" });
});

test("a registration for another contract fails closed", () => {
    assert.throws(
        () => discover({ [REG_FILE]: registration({ contract_version: 2 }), "/opt/cli": "", "/usr/bin/cutready-cli": "" }),
        { code: "contract_mismatch" },
    );
});

test("an unreadable registration fails closed", () => {
    assert.throws(() => discover({ [REG_FILE]: "{", "/usr/bin/cutready-cli": "" }), { code: "cli_not_found" });
    assert.throws(() => discover({ [REG_FILE]: "{}", "/usr/bin/cutready-cli": "" }), { code: "cli_not_found" });
});

test("a registration whose binary is gone fails rather than starting another install", () => {
    assert.throws(() => discover({ [REG_FILE]: registration(), "/usr/bin/cutready-cli": "" }), (err) => {
        assert.equal(err.code, "cli_not_found");
        assert.deepEqual(err.details.tried, ["/opt/cli"]);
        return true;
    });
});

test("an incomplete registration fails closed", () => {
    for (const install of [{ path: "" }, { version: "" }, { contract_version: -1 }, { contract_version: 2 ** 32 }]) {
        assert.throws(() => discover({ [REG_FILE]: registration(install), "/opt/cli": "", "/usr/bin/cutready-cli": "" }), {
            code: "cli_not_found",
        });
    }
});

test("without a registration the bundled install is used", () => {
    const found = discover({ "/usr/bin/cutready-cli": "" });
    assert.deepEqual(found, { path: "/usr/bin/cutready-cli", source: "bundled" });
});

test("nothing installed reports what it tried", () => {
    assert.throws(() => discover({}), (err) => {
        assert.equal(err.code, "cli_not_found");
        assert.ok(err.details.tried.includes("/usr/bin/cutready-cli"));
        return true;
    });
});

test("the registration directory mirrors the Rust config dir", () => {
    assert.equal(registrationDir({ env: { CUTREADY_CONFIG_DIR: "/o" }, platform: "linux", homedir: HOME }), "/o");
    assert.equal(registrationDir({ env: {}, platform: "linux", homedir: HOME }), "/home/me/.config/cutready");
    assert.equal(registrationDir({ env: { XDG_CONFIG_HOME: "/xdg" }, platform: "linux", homedir: HOME }), "/xdg/cutready");
    assert.equal(registrationDir({ env: { XDG_CONFIG_HOME: "rel" }, platform: "linux", homedir: HOME }), "/home/me/.config/cutready");
    assert.equal(
        registrationDir({ env: {}, platform: "darwin", homedir: "/Users/me" }),
        "/Users/me/Library/Application Support/cutready",
    );
    assert.equal(
        registrationDir({ env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, platform: "win32", homedir: "C:\\Users\\me" }),
        "C:\\Users\\me\\AppData\\Roaming\\cutready",
    );
});

test("bundled paths cover each platform's app install", () => {
    assert.ok(bundledPaths({ platform: "darwin", homedir: "/Users/me" }).includes("/Applications/CutReady.app/Contents/MacOS/cutready-cli"));
    assert.deepEqual(
        bundledPaths({ platform: "win32", env: { LOCALAPPDATA: "C:\\L", ProgramFiles: "C:\\P" } }),
        ["C:\\L\\CutReady\\cutready-cli.exe", "C:\\P\\CutReady\\cutready-cli.exe"],
    );
});

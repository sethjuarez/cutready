import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CONTRACT_VERSION } from "../../cutready-canvas/lib/contract.mjs";
import { CutReadyError } from "../../cutready-canvas/lib/errors.mjs";
import { repoRoot } from "./helpers.mjs";

test("the canvas speaks the edit contract cutready-cli speaks", () => {
    const source = readFileSync(path.join(repoRoot, "crates", "cutready-contracts", "src", "lib.rs"), "utf8");
    const match = source.match(/pub const CONTRACT_VERSION: u32 = (\d+);/);
    assert.ok(match, "CONTRACT_VERSION not found in cutready-contracts");
    assert.equal(CONTRACT_VERSION, Number(match[1]));
});

test("a CommandFailure becomes a CutReadyError with its code and details", () => {
    const err = CutReadyError.fromCommandFailure({
        error: { code: "stale_document", message: "Changed on disk", details: { current_version: "v2" } },
    });
    assert.equal(err.code, "stale_document");
    assert.equal(err.message, "Changed on disk");
    assert.deepEqual(err.details, { current_version: "v2" });
    assert.deepEqual(JSON.parse(JSON.stringify(err)), {
        code: "stale_document",
        message: "Changed on disk",
        details: { current_version: "v2" },
    });
    assert.equal(CutReadyError.fromCommandFailure({}).code, "protocol_error");
});

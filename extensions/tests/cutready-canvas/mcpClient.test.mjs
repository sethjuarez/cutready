import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { McpClient } from "../../cutready-canvas/lib/mcpClient.mjs";
import { SKETCH, cliBinary, tempProject, write } from "./helpers.mjs";

const fakeServer = path.join(path.dirname(fileURLToPath(import.meta.url)), "fakeServer.mjs");

function startFake(mode, options = {}) {
    return McpClient.start({
        cliPath: "fake",
        project: "fake",
        spawn: (_cmd, _args, opts) => spawn(process.execPath, [fakeServer, mode], opts),
        ...options,
    });
}

describe("against the real cutready-cli mcp", () => {
    let project;
    let client;

    before(async () => {
        project = tempProject();
        write(project.dir, "notes/plan.md", "Old");
        write(project.dir, "intro.sk", SKETCH);
        client = await McpClient.start({ cliPath: cliBinary(), project: project.dir, clientId: "test-canvas" });
    });

    after(() => {
        client?.close();
        project?.cleanup();
    });

    test("the handshake agrees on the contract and lists the tools", async () => {
        assert.equal(client.serverInfo.name, "cutready");
        const names = (await client.listTools()).map((tool) => tool.name);
        for (const name of ["list_documents", "read_document", "begin_run", "apply_ops", "review", "keep", "undo"]) {
            assert.ok(names.includes(name), name);
        }
    });

    test("list_documents and read_document agree on versions", async () => {
        const report = await client.callTool("list_documents");
        assert.deepEqual(report.documents.map((doc) => doc.path), ["intro.sk", "notes/plan.md"]);
        const note = await client.callTool("read_document", { path: "notes/plan.md" });
        assert.equal(note.content, "Old");
        assert.equal(report.documents[1].version, note.version);
    });

    test("an edit in a run waits for review, then keep resolves it", async () => {
        const note = await client.callTool("read_document", { path: "notes/plan.md" });
        const { run_id } = await client.callTool("begin_run");
        const applied = await client.callTool("apply_ops", {
            run_id,
            path: "notes/plan.md",
            expected_version: note.version,
            ops: [{ kind: "write_note", content: "New" }],
        });
        assert.equal(applied.changed, true);
        assert.equal(readFileSync(path.join(project.dir, "notes/plan.md"), "utf8"), "New");

        const reviews = await client.callTool("review");
        const review = reviews.find((r) => r.run_id === run_id);
        assert.equal(review.actor, "mcp:test-canvas");
        assert.equal(review.documents[0].doc, "notes/plan.md");

        const kept = await client.callTool("keep", { run_id, path: "notes/plan.md", through_seq: review.documents[0].through_seq });
        assert.equal(kept.resolved, "keep");
        assert.ok(!(await client.callTool("review")).some((r) => r.run_id === run_id));
    });

    test("undo restores the document", async () => {
        const note = await client.callTool("read_document", { path: "notes/plan.md" });
        const { run_id } = await client.callTool("begin_run");
        const applied = await client.callTool("apply_ops", {
            run_id,
            path: "notes/plan.md",
            expected_version: note.version,
            ops: [{ kind: "write_note", content: "Oops" }],
        });
        await client.callTool("undo", { run_id, path: "notes/plan.md", through_seq: applied.seq });
        assert.equal(readFileSync(path.join(project.dir, "notes/plan.md"), "utf8"), note.content);
    });

    test("a stale expected version is refused with stale_document", async () => {
        const { run_id } = await client.callTool("begin_run");
        await assert.rejects(
            client.callTool("apply_ops", {
                run_id,
                path: "notes/plan.md",
                expected_version: "not-the-version",
                ops: [{ kind: "write_note", content: "Lost" }],
            }),
            (err) => {
                assert.equal(err.code, "stale_document");
                assert.ok(err.details.current_version);
                return true;
            },
        );
    });

    test("a locked cell is refused with locked_cell", async () => {
        const sketch = await client.callTool("read_document", { path: "intro.sk" });
        const { run_id } = await client.callTool("begin_run");
        const locked = await client.callTool("apply_ops", {
            run_id,
            path: "intro.sk",
            expected_version: sketch.version,
            ops: [
                { kind: "insert_row", after_row_id: null, row: { id: "r1", time: "0:05", narrative: "Hi", demo_actions: "" } },
                { kind: "set_lock", row_id: "r1", field: "narrative", locked: true },
            ],
        });
        await assert.rejects(
            client.callTool("apply_ops", {
                run_id,
                path: "intro.sk",
                expected_version: locked.version,
                ops: [{ kind: "set_row_text", row_id: "r1", narrative: "Changed" }],
            }),
            (err) => {
                assert.equal(err.code, "locked_cell");
                assert.equal(err.details.field, "narrative");
                return true;
            },
        );
        await assert.rejects(
            client.callTool("apply_ops", {
                run_id,
                path: "intro.sk",
                expected_version: locked.version,
                ops: [{ kind: "delete_row", row_id: "missing" }],
            }),
            { code: "row_not_found" },
        );
    });

    test("a run another client began is refused as an invalid request", async () => {
        await assert.rejects(
            client.callTool("keep", { run_id: "someone-else", path: "notes/plan.md", through_seq: 1 }),
            { code: "invalid_request" },
        );
    });
});

describe("handshake failures fail closed", () => {
    test("a server declaring another contract is refused and stopped", async () => {
        await assert.rejects(startFake("wrong-version"), (err) => {
            assert.equal(err.code, "contract_mismatch");
            assert.deepEqual(err.details, { server: 99, canvas: 1 });
            return true;
        });
    });

    test("a server declaring no contract is refused", async () => {
        await assert.rejects(startFake("no-version"), { code: "contract_mismatch" });
    });

    test("a server refusing our contract reports the mismatch", async () => {
        await assert.rejects(startFake("refuse"), { code: "contract_mismatch" });
    });

    test("a silent server times out", async () => {
        await assert.rejects(startFake("silent", { handshakeTimeoutMs: 200 }), { code: "handshake_failed" });
    });

    test("a server writing garbage is a failed handshake", async () => {
        await assert.rejects(startFake("garbage"), { code: "handshake_failed" });
    });

    test("a project that isn't a git repository is a failed handshake with the CLI's reason", async () => {
        await assert.rejects(McpClient.start({ cliPath: cliBinary(), project: path.join(fakeServer, "nope") }), {
            code: "handshake_failed",
        });
    });
});

test("a process that dies fails the pending call and later ones", async () => {
    const client = await startFake("die-on-call");
    const exited = new Promise((resolve) => client.onExit(resolve));
    await assert.rejects(client.callTool("list_documents"), { code: "process_exited" });
    assert.equal((await exited).code, "process_exited");
    assert.equal(client.closed, true);
    await assert.rejects(client.callTool("list_documents"), { code: "process_exited" });
});

test("a tool result without structuredContent is a protocol error", async () => {
    const client = await startFake("ok");
    try {
        await assert.rejects(client.callTool("list_documents"), { code: "protocol_error" });
    } finally {
        client.close();
    }
});

for (const mode of ["huge", "huge-partial"]) {
    test(`an oversized message closes the connection (${mode})`, async () => {
        const client = await startFake(mode, { maxLineBytes: 1024 });
        await assert.rejects(client.callTool("list_documents"), { code: "protocol_error" });
        assert.equal(client.closed, true);
    });
}

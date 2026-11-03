import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { userEdit } from "../../cutready-canvas/lib/documents.mjs";
import { CutReadyError } from "../../cutready-canvas/lib/errors.mjs";
import { Instances } from "../../cutready-canvas/lib/instances.mjs";
import { startServer } from "../../cutready-canvas/lib/server.mjs";

/** A scripted MCP session: `script[tool]` is a value or a function of the args. */
function fakeSession(script) {
    const calls = [];
    const call = async (tool, args) => {
        calls.push([tool, args]);
        const step = script[tool];
        const result = typeof step === "function" ? step(args, calls) : step;
        if (result instanceof Error) throw result;
        return result;
    };
    return {
        calls,
        beginRun: () => call("begin_run"),
        applyOps: (args) => call("apply_ops", args),
        keep: (args) => call("keep", args),
        review: () => call("review"),
        readDocument: (p) => call("read_document", p),
    };
}

const pendingFor = (runId, seq) => [{ run_id: runId, actor: "mcp:x", started_at: "t", documents: [{ doc: "a.sk", through_seq: seq, writes: 1, created: false, last_at: "t" }] }];

describe("a user edit reconciles a run the CLI lost track of", () => {
    test("apply timed out after writing: the write is kept and reported", async () => {
        const session = fakeSession({
            begin_run: { run_id: "r" },
            apply_ops: new CutReadyError("timeout", "no reply"),
            review: pendingFor("r", 1),
            keep: { resolved: 1 },
            read_document: { path: "a.sk", version: "v2", content: "{}" },
        });
        const result = await userEdit(session, { path: "a.sk", expectedVersion: "v1", ops: [{ kind: "set_title", title: "T" }] });
        assert.deepEqual(result, { run_id: "r", path: "a.sk", version: "v2", changed: true, seq: 1 });
        assert.deepEqual(session.calls.find(([tool]) => tool === "keep")[1], { runId: "r", path: "a.sk", throughSeq: 1 });
    });

    test("a rejected edit stays rejected with its code", async () => {
        const session = fakeSession({
            begin_run: { run_id: "r" },
            apply_ops: new CutReadyError("stale_document", "stale"),
            review: [],
        });
        await assert.rejects(userEdit(session, { path: "a.sk", expectedVersion: "v1", ops: [{ kind: "set_title", title: "T" }] }), {
            code: "stale_document",
        });
    });

    test("keep failed once: it is retried from the pending run", async () => {
        let keeps = 0;
        const session = fakeSession({
            begin_run: { run_id: "r" },
            apply_ops: { run_id: "r", path: "a.sk", version: "v2", changed: true, seq: 1 },
            keep: () => (++keeps === 1 ? new CutReadyError("process_exited", "gone") : { resolved: 1 }),
            review: pendingFor("r", 1),
        });
        const result = await userEdit(session, { path: "a.sk", expectedVersion: "v1", ops: [{ kind: "set_title", title: "T" }] });
        assert.equal(result.version, "v2");
        assert.equal(keeps, 2);
    });

    test("when reconciling fails too, the error says the edit may be pending", async () => {
        const session = fakeSession({
            begin_run: { run_id: "r" },
            apply_ops: new CutReadyError("timeout", "no reply"),
            review: new CutReadyError("process_exited", "gone"),
        });
        await assert.rejects(userEdit(session, { path: "a.sk", expectedVersion: "v1", ops: [{ kind: "set_title", title: "T" }] }), (err) => {
            assert.equal(err.code, "timeout");
            assert.match(err.message, /review panel/);
            return true;
        });
    });
});

function fakeSessions() {
    const released = [];
    return {
        released,
        get: (project) => ({ root: project }),
        release: (root) => released.push(root),
    };
}

describe("panel instances", () => {
    test("moving a panel to another project rotates its token and closes old listeners", () => {
        const sessions = fakeSessions();
        const instances = new Instances(sessions);
        const first = instances.open("i", { project: "/a" });
        const heard = [];
        instances.subscribe(first, (event) => heard.push(event));
        const token = first.token;
        assert.equal(instances.open("i", { project: "/a" }).token, token);
        const moved = instances.open("i", { project: "/b" });
        assert.notEqual(moved.token, token);
        assert.equal(instances.byToken(token), undefined);
        assert.deepEqual(heard, ["closed"]);
        assert.deepEqual(sessions.released, ["/a"]);
    });

    test("a project's session is released when its last panel closes", () => {
        const sessions = fakeSessions();
        const instances = new Instances(sessions);
        instances.open("one", { project: "/a" });
        instances.open("two", { project: "/a" });
        instances.close("one");
        assert.deepEqual(sessions.released, []);
        instances.close("two");
        assert.deepEqual(sessions.released, ["/a"]);
    });
});

function get(url, headers) {
    return new Promise((resolve, reject) => {
        request(url, { headers }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
        })
            .on("error", reject)
            .end();
    });
}

describe("server error mapping", () => {
    test("unexpected failures are a generic 500; CLI trouble is 5xx", async () => {
        const webRoot = mkdtempSync(path.join(os.tmpdir(), "cutready-web-"));
        const logged = [];
        const instances = new Instances(fakeSessions());
        const instance = instances.open("i", { project: "/a" });
        const server = await startServer({
            webRoot,
            instances,
            log: (m) => logged.push(m),
            routes: {
                "GET /api/boom": async () => {
                    throw new Error("secret C:\\path detail");
                },
                "GET /api/slow": async () => {
                    throw new CutReadyError("timeout", "no reply");
                },
                "GET /api/gone": async () => {
                    throw new CutReadyError("cli_not_found", "no cli");
                },
            },
        });
        try {
            const headers = { "x-cutready-token": instance.token };
            const boom = await get(`${server.origin}/api/boom`, headers);
            assert.equal(boom.status, 500);
            assert.deepEqual(boom.json, { error: { code: "internal", message: "Internal error" } });
            assert.match(logged.join("\n"), /secret/);
            assert.equal((await get(`${server.origin}/api/slow`, headers)).status, 504);
            assert.equal((await get(`${server.origin}/api/gone`, headers)).status, 503);
        } finally {
            await server.close();
            rmSync(webRoot, { recursive: true, force: true });
        }
    });
});

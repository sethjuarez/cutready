import assert from "node:assert/strict";
import { request } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { cutreadyCanvas } from "../../cutready-canvas/lib/canvas.mjs";
import { SKETCH, cliBinary, tempProject, write } from "./helpers.mjs";

class HostError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function http(url, { method = "GET", headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = request(url, { method, headers }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                let json;
                try {
                    json = JSON.parse(text);
                } catch {}
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
        });
        req.on("error", reject);
        if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
        req.end();
    });
}

/**
 * Subscribes to the panel's server-sent events. Resolves once `hello` arrives,
 * which the server writes before it registers the subscriber, so events
 * emitted after that are never missed. `until(predicate)` resolves with every
 * event so far once one matches, and closes the stream.
 */
function listen(url, timeoutMs = 10_000) {
    return new Promise((ready, reject) => {
        const events = [];
        let waiting;
        let done = false;
        let failure;
        const fail = (err) => {
            if (done) return;
            done = true;
            failure = err;
            clearTimeout(timer);
            req.destroy();
            reject(err);
            waiting?.reject(err);
        };
        const timer = setTimeout(() => fail(new Error(`no matching event within ${timeoutMs} ms`)), timeoutMs);
        const check = () => {
            if (done || !waiting || !events.some(waiting.predicate)) return;
            done = true;
            clearTimeout(timer);
            req.destroy();
            waiting.resolve(events);
        };
        const req = request(url, (res) => {
            let buffer = "";
            res.setEncoding("utf8");
            res.on("close", () => fail(new Error("the event stream ended early")));
            res.on("data", (chunk) => {
                buffer += chunk;
                let end;
                while ((end = buffer.indexOf("\n\n")) >= 0) {
                    const block = buffer.slice(0, end);
                    buffer = buffer.slice(end + 2);
                    const name = block.match(/^event: (.*)$/m)?.[1];
                    const data = JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? "null");
                    events.push({ name, data });
                    if (name === "hello") {
                        ready({
                            until: (predicate) =>
                                new Promise((resolve, rejectUntil) => {
                                    if (failure) return rejectUntil(failure);
                                    waiting = { predicate, resolve, reject: rejectUntil };
                                    check();
                                }),
                        });
                    }
                    check();
                }
            });
        });
        req.on("error", fail);
        req.end();
    });
}

describe("the canvas against the real cutready-cli", () => {
    let project;
    let canvas;
    let opened;
    let origin;
    let token;
    const ctx = { sessionId: "s1", instanceId: "panel-1" };
    const invoke = (actionName, input) =>
        canvas.options.actions.find((a) => a.name === actionName).handler({ ...ctx, actionName, input });
    const api = (route, options = {}) =>
        http(`${origin}${route}`, {
            ...options,
            headers: { "x-cutready-token": token, ...(options.body ? { "content-type": "application/json" } : {}), ...options.headers },
        });

    before(async () => {
        project = tempProject();
        write(project.dir, "intro.sk", SKETCH);
        write(project.dir, "notes/plan.md", "Old");
        canvas = cutreadyCanvas({
            toHostError: (error) => new HostError(error.code, error.message),
            env: { CUTREADY_CLI: cliBinary() },
            clientId: "canvas-test",
        });
        opened = await canvas.options.open({ ...ctx, input: { document: "intro.sk" }, session: { workingDirectory: project.dir } });
        const url = new URL(opened.url);
        origin = url.origin;
        token = url.searchParams.get("token");
    });

    after(async () => {
        await canvas?.dispose();
        project?.cleanup();
    });

    test("open serves a loopback panel and reports the project", () => {
        assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
        assert.equal(opened.status, "2 documents");
        assert.match(opened.title, /^CutReady · /);
    });

    test("reopening the same instance keeps its URL", async () => {
        const again = await canvas.options.open({ ...ctx, input: {}, session: { workingDirectory: project.dir } });
        assert.equal(again.url, opened.url);
    });

    test("static assets are served with a CSP, and nothing outside web/", async () => {
        const index = await http(`${origin}/`);
        assert.equal(index.status, 200);
        assert.match(index.headers["content-security-policy"], /default-src 'none'/);
        assert.equal((await http(`${origin}/views/review.js`)).status, 200);
        assert.equal((await http(`${origin}/..%2flib%2fcanvas.mjs`)).status, 404);
        assert.equal((await http(`${origin}/%2e%2e/extension.mjs`)).status, 404);
    });

    test("the API refuses a missing token, a foreign host, a foreign origin and non-JSON", async () => {
        assert.equal((await http(`${origin}/api/documents`)).status, 401);
        assert.equal((await api("/api/documents", { headers: { host: "evil.example" } })).status, 421);
        assert.equal((await api("/api/edit", { method: "POST", body: {}, headers: { origin: "https://evil.example" } })).status, 403);
        assert.equal((await api("/api/edit", { method: "POST", body: "x", headers: { "content-type": "text/plain" } })).status, 415);
    });

    test("a user edit from the panel is kept at once", async () => {
        const note = (await api("/api/document?path=notes/plan.md")).json;
        assert.equal(note.kind, "note");
        const edited = await api("/api/edit", {
            method: "POST",
            body: { path: "notes/plan.md", expectedVersion: note.version, ops: [{ kind: "write_note", content: "Mine" }] },
        });
        assert.equal(edited.status, 200);
        assert.equal(readFileSync(path.join(project.dir, "notes/plan.md"), "utf8"), "Mine");
        assert.deepEqual((await api("/api/reviews")).json, []);
    });

    test("a stale panel edit is a 409 stale_document", async () => {
        const res = await api("/api/edit", {
            method: "POST",
            body: { path: "notes/plan.md", expectedVersion: "sha256:old", ops: [{ kind: "write_note", content: "Lost" }] },
        });
        assert.equal(res.status, 409);
        assert.equal(res.json.error.code, "stale_document");
    });

    test("an agent edit stays pending, notifies the panel, and keep resolves it", async () => {
        const sketch = await invoke("read_document", { path: "intro.sk" });
        assert.equal(sketch.kind, "sketch");
        assert.equal(sketch.content.title, "Intro");
        const stream = await listen(`${origin}/events?token=${token}`);
        const applied = await invoke("apply_ops", {
            path: "intro.sk",
            expected_version: sketch.version,
            ops: [{ kind: "set_title", title: "Welcome" }],
        });
        const events = await stream.until((e) => e.name === "changed");
        assert.equal(events[0].name, "hello");
        assert.deepEqual(events.at(-1).data, { path: "intro.sk", by: "agent" });

        const pending = (await api("/api/reviews")).json;
        assert.equal(pending.length, 1);
        assert.equal(pending[0].run_id, applied.run_id);
        assert.equal(pending[0].path, "intro.sk");

        const kept = await invoke("keep", { run_id: applied.run_id, path: "intro.sk" });
        assert.equal(kept.resolved, "keep");
        assert.deepEqual(await invoke("review", {}), []);
        assert.equal(JSON.parse(readFileSync(path.join(project.dir, "intro.sk"), "utf8")).title, "Welcome");
    });

    test("the panel can undo an agent edit", async () => {
        const note = await invoke("read_document", { path: "notes/plan.md" });
        const applied = await invoke("apply_ops", { path: "notes/plan.md", expected_version: note.version, ops: [{ kind: "write_note", content: "Agent" }] });
        const [item] = (await api("/api/reviews")).json;
        const res = await api("/api/review", { method: "POST", body: { decision: "undo", runId: applied.run_id, path: item.path, throughSeq: item.through_seq } });
        assert.equal(res.status, 200);
        assert.equal(readFileSync(path.join(project.dir, "notes/plan.md"), "utf8"), "Mine");
    });

    test("agent errors keep their CmdError code", async () => {
        const sketch = await invoke("read_document", { path: "intro.sk" });
        await assert.rejects(
            invoke("apply_ops", { path: "intro.sk", expected_version: sketch.version, ops: [{ kind: "delete_row", row_id: "nope" }] }),
            (err) => err instanceof HostError && err.code === "row_not_found",
        );
        await assert.rejects(invoke("apply_ops", { path: "intro.sk", expected_version: sketch.version, ops: [] }), { code: "invalid_request" });
        await assert.rejects(invoke("read_document", { path: "missing.sk" }), { code: "document_not_found" });
        await assert.rejects(invoke("keep", { run_id: "nope", path: "intro.sk" }), { code: "invalid_request" });
    });

    test("open_document focuses the panel", async () => {
        const stream = await listen(`${origin}/events?token=${token}`);
        await invoke("open_document", { path: "notes/plan.md" });
        const events = await stream.until((e) => e.name === "focus");
        assert.deepEqual(events.at(-1).data, { path: "notes/plan.md" });
    });

    test("closing the panel revokes its token", async () => {
        await canvas.options.onClose(ctx);
        assert.equal((await api("/api/documents")).status, 401);
        await assert.rejects(invoke("list_documents", {}), { code: "invalid_request" });
    });
});

test("opening a folder that doesn't exist is no_project", async () => {
    const canvas = cutreadyCanvas({ toHostError: (e) => new HostError(e.code, e.message), env: {}, clientId: "x" });
    try {
        await assert.rejects(
            canvas.options.open({ sessionId: "s", instanceId: "i", input: { project: path.join(cliBinary(), "nope") } }),
            { code: "no_project" },
        );
    } finally {
        await canvas.dispose();
    }
});

test("a canvas without a CLI still opens and says why", async () => {
    const project = tempProject();
    const canvas = cutreadyCanvas({
        toHostError: (e) => new HostError(e.code, e.message),
        env: { CUTREADY_CLI: path.join(project.dir, "no-cli") },
        clientId: "x",
    });
    try {
        const opened = await canvas.options.open({ sessionId: "s", instanceId: "i", input: { project: project.dir } });
        assert.match(opened.status, /doesn't exist/);
    } finally {
        await canvas.dispose();
        project.cleanup();
    }
});

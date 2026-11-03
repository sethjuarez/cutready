import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { loadClientId } from "../../cutready-canvas/lib/clientId.mjs";
import { ProjectSessions, canonicalProject } from "../../cutready-canvas/lib/projectSessions.mjs";
import { canvasRoot, cliBinary, tempDir, tempProject, write } from "./helpers.mjs";

test("the client id is created once and reused", () => {
    const temp = tempDir();
    try {
        const dir = path.join(temp.dir, "artifacts");
        const id = loadClientId(dir);
        assert.match(id, /^[A-Za-z0-9._-]{1,64}$/);
        assert.equal(loadClientId(dir), id);
        assert.equal(readFileSync(path.join(dir, "client-id"), "utf8").trim(), id);
    } finally {
        temp.cleanup();
    }
});

test("racing canvas processes settle on one client id", async () => {
    const temp = tempDir();
    try {
        const dir = path.join(temp.dir, "artifacts");
        const module = pathToFileURL(path.join(canvasRoot, "lib", "clientId.mjs")).href;
        const script = `import { loadClientId } from ${JSON.stringify(module)}; process.stdout.write(loadClientId(${JSON.stringify(dir)}));`;
        const runs = Array.from({ length: 12 }, () =>
            new Promise((resolve, reject) =>
                execFile(process.execPath, ["--input-type=module", "-e", script], (err, stdout) => (err ? reject(err) : resolve(stdout))),
            ),
        );
        const ids = new Set(await Promise.all(runs));
        assert.equal(ids.size, 1);
        assert.equal(readFileSync(path.join(dir, "client-id"), "utf8").trim(), [...ids][0]);
    } finally {
        temp.cleanup();
    }
});

test("a project must be an existing folder", () => {
    assert.throws(() => canonicalProject(undefined), { code: "no_project" });
    assert.throws(() => canonicalProject("  "), { code: "no_project" });
    assert.throws(() => canonicalProject(path.join(tempDir().dir, "missing")), { code: "no_project" });
});

function sessions(clientId) {
    return new ProjectSessions({ clientId, env: { CUTREADY_CLI: cliBinary() } });
}

test("a restarted canvas with the same client id can keep its earlier run", async () => {
    const project = tempProject();
    write(project.dir, "notes/plan.md", "Old");
    const first = sessions("restart-test");
    let runId;
    let seq;
    try {
        const session = first.get(project.dir);
        const note = await session.readDocument("notes/plan.md");
        ({ run_id: runId } = await session.beginRun());
        ({ seq } = await session.applyOps({ runId, path: "notes/plan.md", expectedVersion: note.version, ops: [{ kind: "write_note", content: "New" }] }));
        assert.equal(session.cli.source, "env");
    } finally {
        first.closeAll();
    }

    const stranger = sessions("someone-else");
    const again = sessions("restart-test");
    try {
        assert.deepEqual(await stranger.get(project.dir).review(), []);
        const session = again.get(project.dir);
        const [review] = await session.review();
        assert.equal(review.run_id, runId);
        const kept = await session.keep({ runId, path: "notes/plan.md", throughSeq: seq });
        assert.equal(kept.resolved, "keep");
    } finally {
        stranger.closeAll();
        again.closeAll();
        project.cleanup();
    }
});

test("the same folder shares one session, and a dead connection is replaced on the next call", async () => {
    const project = tempProject();
    const all = sessions("share-test");
    try {
        const a = all.get(project.dir);
        assert.equal(all.get(path.join(project.dir, ".")), a);
        await a.listDocuments();
        a.close();
        const report = await a.listDocuments();
        assert.equal(report.ok, true);
    } finally {
        all.closeAll();
        project.cleanup();
    }
});

test("a bad explicit cliPath fails, and a corrected one reconnects", async () => {
    const project = tempProject();
    const all = new ProjectSessions({ clientId: "path-test", env: {} });
    try {
        const bad = path.join(project.dir, "no-such-cli");
        assert.equal(existsSync(bad), false);
        await assert.rejects(all.get(project.dir, { cliPath: bad }).listDocuments(), { code: "cli_not_found" });
        const report = await all.get(project.dir, { cliPath: cliBinary() }).listDocuments();
        assert.equal(report.ok, true);
    } finally {
        all.closeAll();
        project.cleanup();
    }
});

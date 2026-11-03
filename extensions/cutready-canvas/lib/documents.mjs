// Document-level operations the canvas offers, on top of one project's
// `cutready-cli mcp` session. Everything here goes through typed EditOps in a
// run; nothing touches project files directly.
import { CANVAS_ERRORS } from "./contract.mjs";
import { CutReadyError } from "./errors.mjs";

const KINDS = { ".sk": "sketch", ".sb": "storyboard", ".md": "note" };

export function documentKind(docPath) {
    const dot = docPath.lastIndexOf(".");
    return KINDS[dot >= 0 ? docPath.slice(dot).toLowerCase() : ""];
}

/** The project's documents grouped by kind, with any that don't parse. */
export async function listDocuments(session) {
    const report = await session.listDocuments();
    const documents = report.documents.map((doc) => ({ ...doc, kind: documentKind(doc.path) }));
    return { ok: report.ok, documents };
}

/** One document: `{ path, kind, version, content }`; sketches and storyboards are parsed. */
export async function readDocument(session, docPath) {
    const kind = documentKind(docPath);
    if (!kind) throw new CutReadyError(CANVAS_ERRORS.INVALID_REQUEST, `${docPath} isn't a sketch, storyboard or note`);
    const doc = await session.readDocument(docPath);
    if (doc.content === null) {
        throw new CutReadyError("document_not_found", `${docPath} doesn't exist`, { path: docPath });
    }
    let content = doc.content;
    if (kind !== "note") {
        try {
            content = JSON.parse(doc.content);
        } catch {
            throw new CutReadyError("invalid_document", `${docPath} isn't valid JSON`, { path: docPath });
        }
    }
    return { path: doc.path, kind, version: doc.version, content };
}

function requireOps(ops) {
    if (!Array.isArray(ops) || ops.length === 0 || !ops.every((op) => op && typeof op.kind === "string")) {
        throw new CutReadyError(CANVAS_ERRORS.INVALID_REQUEST, "ops must be a non-empty array of EditOps with a kind");
    }
}

/**
 * A user's edit from the canvas: applied in its own run and kept at once,
 * like typing in the app. Returns the applied result.
 *
 * If the CLI fails after the write may have landed (a timeout or a crash
 * between apply and keep), the run is reconciled: whatever it wrote is kept,
 * so a user edit never lingers in the review panel and a retry doesn't
 * reapply it.
 */
export async function userEdit(session, { path, expectedVersion, ops }) {
    requireOps(ops);
    const { run_id: runId } = await session.beginRun();
    let applied;
    try {
        applied = await session.applyOps({ runId, path, expectedVersion, ops });
        if (applied.seq !== null && applied.seq !== undefined) {
            await session.keep({ runId, path, throughSeq: applied.seq });
        }
        return applied;
    } catch (err) {
        const settled = await settleUserRun(session, runId, path).catch(() => undefined);
        if (settled === undefined) {
            throw new CutReadyError(
                err.code ?? "internal",
                `${err.message}. The edit may still be pending; check the review panel.`,
                err.details,
            );
        }
        if (settled === null) {
            // Nothing pending: either the write never landed, or keep did land.
            if (applied) return applied;
            throw err;
        }
        if (applied) return applied;
        // Kept already; a failed read must not look like a failed edit.
        const doc = await session.readDocument(path).catch(() => ({ version: null }));
        return { run_id: runId, path, version: doc.version, changed: true, seq: settled };
    }
}

// Keeps whatever `runId` left pending on `path`. Returns the kept seq, or
// null when nothing was pending (the write never landed).
async function settleUserRun(session, runId, path) {
    const pending = (await pendingReviews(session)).find((p) => p.run_id === runId && p.path === path);
    if (!pending) return null;
    await session.keep({ runId, path, throughSeq: pending.through_seq });
    return pending.through_seq;
}

/**
 * An agent's edit: applied in `runId` (or a new run) and left pending for the
 * user to keep or undo. Returns the applied result with its `run_id`.
 */
export async function agentEdit(session, { runId, path, expectedVersion, ops }) {
    requireOps(ops);
    const run = runId || (await session.beginRun()).run_id;
    const applied = await session.applyOps({ runId: run, path, expectedVersion, ops });
    return { ...applied, run_id: run };
}

/** Pending runs this canvas began, newest first, one entry per document. */
export async function pendingReviews(session) {
    const runs = await session.review();
    const pending = [];
    for (const run of runs) {
        for (const doc of run.documents) {
            pending.push({
                run_id: run.run_id,
                actor: run.actor,
                started_at: run.started_at,
                path: doc.doc,
                through_seq: doc.through_seq,
                writes: doc.writes,
                created: doc.created,
                last_at: doc.last_at,
            });
        }
    }
    return pending.sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)));
}

export function resolveReview(session, { decision, runId, path, throughSeq }) {
    if (decision === "keep") return session.keep({ runId, path, throughSeq });
    if (decision === "undo") return session.undo({ runId, path, throughSeq });
    throw new CutReadyError(CANVAS_ERRORS.INVALID_REQUEST, `decision must be "keep" or "undo", not ${JSON.stringify(decision)}`);
}

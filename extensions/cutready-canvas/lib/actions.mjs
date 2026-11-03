// Actions Copilot can invoke on an open CutReady canvas. Agent edits go into a
// run and stay pending until the user keeps or undoes them in the review
// panel (or the agent is asked to). Errors keep their CmdError code.
import { agentEdit, listDocuments, pendingReviews, readDocument, resolveReview } from "./documents.mjs";
import { CANVAS_ERRORS } from "./contract.mjs";
import { CutReadyError, asCutReadyError } from "./errors.mjs";

const PATH = { type: "string", description: "Project-relative document path, e.g. intro.sk, launch.sb or notes/plan.md" };
const RESOLVE_INPUT = {
    type: "object",
    properties: {
        run_id: { type: "string" },
        path: PATH,
        through_seq: { type: "integer", description: "Resolve writes up to this sequence; defaults to the latest pending write" },
    },
    required: ["run_id", "path"],
};

const DEFINITIONS = [
    {
        name: "list_documents",
        description: "List the project's sketches (.sk), storyboards (.sb) and notes (.md) with their versions.",
        inputSchema: { type: "object", properties: {} },
        run: (instance) => listDocuments(instance.session),
    },
    {
        name: "read_document",
        description: "Read one document. Returns { path, kind, version, content }; pass version as expected_version to apply_ops.",
        inputSchema: { type: "object", properties: { path: PATH }, required: ["path"] },
        run: (instance, input) => readDocument(instance.session, input.path),
    },
    {
        name: "open_document",
        description: "Show a document in the canvas panel.",
        inputSchema: { type: "object", properties: { path: PATH }, required: ["path"] },
        run: async (instance, input, instances) => {
            const doc = await readDocument(instance.session, input.path);
            instances.emit(instance, "focus", { path: doc.path });
            return { path: doc.path, kind: doc.kind, version: doc.version };
        },
    },
    {
        name: "apply_ops",
        description:
            "Apply typed CutReady EditOps (cutready-cli contract) to one document inside a run. The edit is written at once and stays pending for review. " +
            "Omit run_id to begin a new run; pass the returned run_id to group more edits. Fails with stale_document if expected_version is out of date, " +
            "locked_cell / locked_row / locked_document if a lock blocks it, and row_not_found for an unknown row id.",
        inputSchema: {
            type: "object",
            properties: {
                path: PATH,
                expected_version: { type: ["string", "null"], description: "version from read_document; null only to create a new document" },
                ops: { type: "array", items: { type: "object", properties: { kind: { type: "string" } }, required: ["kind"] }, minItems: 1 },
                run_id: { type: "string" },
            },
            required: ["path", "expected_version", "ops"],
        },
        run: async (instance, input, instances) => {
            const applied = await agentEdit(instance.session, {
                runId: input.run_id,
                path: input.path,
                expectedVersion: input.expected_version,
                ops: input.ops,
            });
            instances.emit(instance, "changed", { path: input.path, by: "agent" });
            return applied;
        },
    },
    {
        name: "review",
        description: "List this canvas's pending runs: one entry per run and document, with through_seq for keep/undo.",
        inputSchema: { type: "object", properties: {} },
        run: (instance) => pendingReviews(instance.session),
    },
    {
        name: "keep",
        description: "Keep a pending run's edits to a document. Only do this when the user asked; otherwise leave it for the review panel.",
        inputSchema: RESOLVE_INPUT,
        run: (instance, input, instances) => resolve(instance, input, instances, "keep"),
    },
    {
        name: "undo",
        description: "Undo a pending run's edits to a document, restoring it.",
        inputSchema: RESOLVE_INPUT,
        run: (instance, input, instances) => resolve(instance, input, instances, "undo"),
    },
    {
        name: "refresh",
        description: "Reload the canvas panel's document list, document and review panel.",
        inputSchema: { type: "object", properties: {} },
        run: async (instance, _input, instances) => {
            instances.emit(instance, "changed", { by: "agent" });
            return { refreshed: true };
        },
    },
];

async function resolve(instance, input, instances, decision) {
    let throughSeq = input.through_seq;
    if (throughSeq === undefined || throughSeq === null) {
        const pending = (await pendingReviews(instance.session)).find((p) => p.run_id === input.run_id && p.path === input.path);
        if (!pending) {
            throw new CutReadyError(CANVAS_ERRORS.INVALID_REQUEST, `Nothing pending for run ${input.run_id} on ${input.path}`);
        }
        throughSeq = pending.through_seq;
    }
    const result = await resolveReview(instance.session, { decision, runId: input.run_id, path: input.path, throughSeq });
    instances.emit(instance, "changed", { path: input.path, by: "review" });
    return result;
}

/**
 * The canvas's action list with handlers bound.
 * @param {object} options
 * @param {import("./instances.mjs").Instances} options.instances
 * @param {(ctx) => string} options.keyOf instance key for an invoke request
 * @param {(error: CutReadyError) => Error} options.toHostError e.g. CanvasError
 */
export function canvasActions({ instances, keyOf, toHostError }) {
    return DEFINITIONS.map(({ name, description, inputSchema, run }) => ({
        name,
        description,
        inputSchema,
        handler: async (ctx) => {
            try {
                const input = ctx.input && typeof ctx.input === "object" ? ctx.input : {};
                return await run(instances.get(keyOf(ctx)), input, instances);
            } catch (err) {
                throw toHostError(asCutReadyError(err));
            }
        },
    }));
}

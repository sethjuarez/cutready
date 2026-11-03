// Composes the canvas from its parts: project sessions, panel instances, the
// loopback server and the agent actions. Kept free of the Copilot SDK so tests
// can drive open/close/actions directly; extension.mjs adds the SDK binding.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiRoutes } from "./api.mjs";
import { canvasActions } from "./actions.mjs";
import { artifactsDir, loadClientId } from "./clientId.mjs";
import { asCutReadyError } from "./errors.mjs";
import { Instances } from "./instances.mjs";
import { ProjectSessions } from "./projectSessions.mjs";
import { startServer } from "./server.mjs";

export const CANVAS_ID = "cutready";
const WEB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

export const OPEN_SCHEMA = {
    type: "object",
    properties: {
        project: { type: "string", description: "CutReady project folder; defaults to the session's working directory" },
        cliPath: { type: "string", description: "cutready-cli binary to use instead of discovering one" },
        document: { type: "string", description: "Document to show first, e.g. intro.sk" },
    },
};

const keyOf = (ctx) => `${ctx.sessionId}:${ctx.instanceId}`;

/**
 * @param {object} options
 * @param {(error) => Error} options.toHostError wraps a CutReadyError for the host (CanvasError)
 * @param {(message: string) => void} [options.log]
 * @param {object} [options.env]
 * @param {string} [options.clientId] defaults to the persisted per-user id
 */
export function cutreadyCanvas({ toHostError, log = () => {}, env = process.env, clientId, sessions } = {}) {
    sessions ??= new ProjectSessions({
        clientId: clientId ?? loadClientId(artifactsDir(env)),
        env,
        clientInfo: { name: "cutready-canvas", version: "1" },
    });
    const instances = new Instances(sessions);
    let server;

    const serverReady = () =>
        (server ??= startServer({ webRoot: WEB_ROOT, instances, routes: apiRoutes(instances), log }).catch((err) => {
            server = undefined;
            throw err;
        }));

    async function open(ctx) {
        const input = ctx.input && typeof ctx.input === "object" ? ctx.input : {};
        let instance;
        try {
            instance = instances.open(keyOf(ctx), {
                project: input.project ?? ctx.session?.workingDirectory,
                cliPath: input.cliPath,
            });
        } catch (err) {
            throw toHostError(asCutReadyError(err));
        }
        if (typeof input.document === "string") instance.focus = input.document;
        const http = await serverReady();
        let status;
        try {
            const { documents } = await instance.session.listDocuments();
            status = `${documents.length} document${documents.length === 1 ? "" : "s"}`;
        } catch (err) {
            // The panel shows the full error; opening still succeeds so the user can see it.
            status = asCutReadyError(err).message;
        }
        return { url: http.urlFor(instance), title: `CutReady · ${path.basename(instance.project)}`, status };
    }

    return {
        options: {
            id: CANVAS_ID,
            displayName: "CutReady",
            description:
                "Browse and edit a CutReady project's sketches, storyboards and notes through cutready-cli, and review pending agent runs with Keep/Undo.",
            inputSchema: OPEN_SCHEMA,
            actions: canvasActions({ instances, keyOf, toHostError }),
            open,
            onClose: (ctx) => instances.close(keyOf(ctx)),
        },
        instances,
        async dispose() {
            sessions.closeAll();
            if (server) await (await server).close();
        },
    };
}

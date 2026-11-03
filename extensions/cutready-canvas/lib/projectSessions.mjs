// One `cutready-cli mcp` connection per project folder, shared by every
// canvas panel showing that project. A dead connection is replaced on the
// next call; the call that saw it die is not replayed.
import { realpathSync } from "node:fs";
import path from "node:path";
import { CANVAS_ERRORS } from "./contract.mjs";
import { discoverCli } from "./discovery.mjs";
import { CutReadyError } from "./errors.mjs";
import { McpClient } from "./mcpClient.mjs";

export function canonicalProject(project) {
    if (typeof project !== "string" || !project.trim()) {
        throw new CutReadyError(CANVAS_ERRORS.NO_PROJECT, "Open the canvas with a project folder, or from a session whose working directory is one");
    }
    const resolved = path.resolve(project);
    try {
        return realpathSync.native(resolved);
    } catch {
        throw new CutReadyError(CANVAS_ERRORS.NO_PROJECT, `Project folder ${resolved} doesn't exist`);
    }
}

/** Typed calls to one project's `cutready-cli mcp` tools. */
export class ProjectSession {
    #connect;
    #client;
    #connecting;
    #generation = 0;

    constructor(root, connect) {
        this.root = root;
        this.#connect = connect;
    }

    /** The binary this session runs, once connected. */
    cli;

    /** An explicit binary to run instead of discovering one. */
    cliPath;

    async #live() {
        if (this.#client && !this.#client.closed) return this.#client;
        if (!this.#connecting) {
            const generation = this.#generation;
            this.#connecting = this.#connect(this.root, this.cliPath)
                .then(({ client, cli }) => {
                    if (generation !== this.#generation) {
                        client.close();
                        throw new CutReadyError(CANVAS_ERRORS.PROCESS_EXITED, "The connection was closed while starting");
                    }
                    this.#client = client;
                    this.cli = cli;
                    return client;
                })
                .finally(() => {
                    if (generation === this.#generation) this.#connecting = undefined;
                });
        }
        return this.#connecting;
    }

    async call(tool, args = {}) {
        const client = await this.#live();
        return client.callTool(tool, args);
    }

    listDocuments() {
        return this.call("list_documents");
    }

    readDocument(path) {
        return this.call("read_document", { path });
    }

    beginRun() {
        return this.call("begin_run");
    }

    applyOps({ runId, path, expectedVersion, ops }) {
        return this.call("apply_ops", {
            run_id: runId,
            path,
            expected_version: expectedVersion ?? null,
            ops,
        });
    }

    review() {
        return this.call("review");
    }

    keep({ runId, path, throughSeq }) {
        return this.call("keep", { run_id: runId, path, through_seq: throughSeq });
    }

    undo({ runId, path, throughSeq }) {
        return this.call("undo", { run_id: runId, path, through_seq: throughSeq });
    }

    close() {
        this.#generation++;
        this.#connecting = undefined;
        this.#client?.close();
        this.#client = undefined;
    }
}

export class ProjectSessions {
    #sessions = new Map();
    #options;

    /**
     * @param {object} options
     * @param {string} options.clientId stable id; see clientId.mjs
     * @param {(opts) => {path, source}} [options.discover]
     * @param {(opts) => Promise<McpClient>} [options.startClient]
     * @param {object} [options.env]
     */
    constructor({ clientId, discover = discoverCli, startClient = (opts) => McpClient.start(opts), env = process.env, clientInfo } = {}) {
        this.#options = { clientId, discover, startClient, env, clientInfo };
    }

    /** The session for `project`, created on first use. A new `cliPath` reconnects. */
    get(project, { cliPath } = {}) {
        const root = canonicalProject(project);
        let session = this.#sessions.get(root);
        if (!session) {
            session = new ProjectSession(root, async (dir, path) => {
                const { discover, startClient, env, clientId, clientInfo } = this.#options;
                const cli = discover({ cliPath: path, env });
                const client = await startClient({ cliPath: cli.path, project: dir, clientId, clientInfo });
                return { client, cli };
            });
            this.#sessions.set(root, session);
        }
        if (cliPath && cliPath !== session.cliPath) {
            session.close();
            session.cliPath = cliPath;
        }
        return session;
    }

    closeAll() {
        for (const session of this.#sessions.values()) session.close();
        this.#sessions.clear();
    }
}

// A client for `cutready-cli mcp <project>`: newline-delimited JSON-RPC 2.0
// over the child's stdio. It checks the edit contract on the handshake and
// fails closed on a mismatch. It never replays a request: when the process
// dies every pending call fails, and the caller decides whether to start a
// new client for its next operation.
import { spawn as nodeSpawn } from "node:child_process";
import { CANVAS_ERRORS, CONTRACT_VERSION, PROTOCOL_VERSION, RPC } from "./contract.mjs";
import { CutReadyError } from "./errors.mjs";

const DEFAULTS = Object.freeze({
    handshakeTimeoutMs: 15_000,
    requestTimeoutMs: 60_000,
    maxLineBytes: 32 * 1024 * 1024,
    stderrBytes: 8 * 1024,
});

export class McpClient {
    #child;
    #options;
    #nextId = 1;
    #pending = new Map();
    #buffer = "";
    #stderr = "";
    #exited = false;
    #exitListeners = new Set();
    #writeChain = Promise.resolve();

    /** Starts `cutready-cli mcp <project>` and completes the handshake. */
    static async start({ cliPath, project, clientId, clientInfo, spawn = nodeSpawn, ...options }) {
        if (!cliPath) throw new CutReadyError(CANVAS_ERRORS.CLI_NOT_FOUND, "No cutready-cli path");
        if (!project) throw new CutReadyError(CANVAS_ERRORS.NO_PROJECT, "No project folder");
        const child = spawn(cliPath, ["mcp", project], {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        const client = new McpClient(child, { ...DEFAULTS, ...options });
        try {
            await client.#handshake({ clientId, clientInfo });
        } catch (err) {
            client.close();
            throw err;
        }
        return client;
    }

    constructor(child, options) {
        this.#child = child;
        this.#options = options;
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => this.#onData(chunk));
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            this.#stderr = (this.#stderr + chunk).slice(-this.#options.stderrBytes);
        });
        child.stdin.on("error", () => {});
        child.on("error", (err) => this.#onExit(`could not start cutready-cli: ${err.message}`));
        // "close" waits for stdout to drain, so a final response is read first.
        child.on("close", (code, signal) => this.#onExit(`cutready-cli exited (${signal ?? code})`));
    }

    get closed() {
        return this.#exited;
    }

    /** Recent stderr output of the child, for diagnostics. */
    get stderr() {
        return this.#stderr;
    }

    /** Calls `cb(error)` once when the process goes away. */
    onExit(cb) {
        if (this.#exited) {
            queueMicrotask(() => cb(this.#exitError()));
            return () => {};
        }
        this.#exitListeners.add(cb);
        return () => this.#exitListeners.delete(cb);
    }

    async listTools() {
        const result = await this.request("tools/list", {});
        return result.tools;
    }

    /**
     * Calls a tool and returns its `structuredContent`. A refused tool call
     * (`isError`) throws its CmdError as a CutReadyError.
     */
    async callTool(name, args = {}, { timeoutMs } = {}) {
        const result = await this.request("tools/call", { name, arguments: args }, { timeoutMs });
        if (!result || typeof result !== "object" || !("structuredContent" in result)) {
            throw new CutReadyError(CANVAS_ERRORS.PROTOCOL, `${name} returned no structuredContent`);
        }
        if (result.isError) throw CutReadyError.fromCommandFailure(result.structuredContent);
        return result.structuredContent;
    }

    request(method, params, { timeoutMs = this.#options.requestTimeoutMs } = {}) {
        if (this.#exited) return Promise.reject(this.#exitError());
        const id = this.#nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new CutReadyError(CANVAS_ERRORS.TIMEOUT, `cutready-cli didn't answer ${method} within ${timeoutMs} ms`));
                // The server answers in order; a stuck call means a stuck server.
                this.close();
            }, timeoutMs);
            this.#pending.set(id, { method, resolve, reject, timer });
            this.#write({ jsonrpc: "2.0", id, method, params }).catch((err) => {
                this.#settle(id, undefined, new CutReadyError(CANVAS_ERRORS.PROCESS_EXITED, err.message));
            });
        });
    }

    notify(method, params) {
        if (this.#exited) return Promise.resolve();
        return this.#write({ jsonrpc: "2.0", method, params }).catch(() => {});
    }

    close() {
        if (!this.#exited) {
            try {
                this.#child.stdin.end();
            } catch {
                // already closed
            }
            this.#child.kill();
        }
        this.#onExit("closed");
    }

    async #handshake({ clientId, clientInfo }) {
        const cutready = { contractVersion: CONTRACT_VERSION };
        if (clientId) cutready.clientId = clientId;
        let result;
        try {
            result = await this.request(
                "initialize",
                {
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: { experimental: { cutready } },
                    clientInfo: clientInfo ?? { name: "cutready-canvas", version: "1" },
                },
                { timeoutMs: this.#options.handshakeTimeoutMs },
            );
        } catch (err) {
            if (err instanceof CutReadyError && err.code === CANVAS_ERRORS.CONTRACT_MISMATCH) throw err;
            const detail = this.#stderr.trim();
            throw new CutReadyError(
                CANVAS_ERRORS.HANDSHAKE_FAILED,
                `cutready-cli mcp handshake failed: ${err.message}${detail ? ` (${detail})` : ""}`,
            );
        }
        const declared = result?.capabilities?.experimental?.cutready?.contractVersion;
        if (declared !== CONTRACT_VERSION) {
            throw new CutReadyError(
                CANVAS_ERRORS.CONTRACT_MISMATCH,
                `cutready-cli speaks edit contract ${declared ?? "(none)"}; this canvas speaks ${CONTRACT_VERSION}. Update CutReady or the canvas so they match.`,
                { server: declared ?? null, canvas: CONTRACT_VERSION },
            );
        }
        this.serverInfo = result.serverInfo;
        await this.notify("notifications/initialized", {});
    }

    #write(message) {
        const line = `${JSON.stringify(message)}\n`;
        const next = this.#writeChain.then(
            () =>
                new Promise((resolve, reject) => {
                    if (this.#exited) return reject(this.#exitError());
                    this.#child.stdin.write(line, "utf8", (err) => (err ? reject(err) : resolve()));
                }),
        );
        this.#writeChain = next.catch(() => {});
        return next;
    }

    #onData(chunk) {
        this.#buffer += chunk;
        let newline;
        while ((newline = this.#buffer.indexOf("\n")) >= 0) {
            const line = this.#buffer.slice(0, newline).trim();
            this.#buffer = this.#buffer.slice(newline + 1);
            if (this.#oversized(line)) return;
            if (line) this.#onLine(line);
            if (this.#exited) return;
        }
        this.#oversized(this.#buffer);
    }

    #oversized(text) {
        if (Buffer.byteLength(text, "utf8") <= this.#options.maxLineBytes) return false;
        this.#buffer = "";
        this.#failAll(new CutReadyError(CANVAS_ERRORS.PROTOCOL, "cutready-cli sent an oversized message"));
        this.close();
        return true;
    }

    #onLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            this.#failAll(new CutReadyError(CANVAS_ERRORS.PROTOCOL, "cutready-cli wrote something that isn't JSON-RPC"));
            this.close();
            return;
        }
        if (message?.jsonrpc !== "2.0" || !("id" in message)) return;
        if (message.error) {
            this.#settle(message.id, undefined, rpcError(message.error));
        } else {
            this.#settle(message.id, message.result);
        }
    }

    #settle(id, result, error) {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        if (error) pending.reject(error);
        else pending.resolve(result);
    }

    #failAll(error) {
        for (const id of [...this.#pending.keys()]) this.#settle(id, undefined, error);
    }

    #exitError() {
        const detail = this.#stderr.trim();
        return new CutReadyError(
            CANVAS_ERRORS.PROCESS_EXITED,
            `${this.#exitReason ?? "cutready-cli is not running"}${detail ? `: ${detail}` : ""}`,
        );
    }

    #exitReason;

    #onExit(reason) {
        if (this.#exited) return;
        this.#exited = true;
        this.#exitReason = reason;
        const error = this.#exitError();
        this.#failAll(error);
        for (const cb of this.#exitListeners) {
            try {
                cb(error);
            } catch {
                // listeners can't break shutdown
            }
        }
        this.#exitListeners.clear();
    }
}

function rpcError(error) {
    const message = String(error?.message ?? "JSON-RPC error");
    switch (error?.code) {
        case RPC.CONTRACT_MISMATCH:
            return new CutReadyError(CANVAS_ERRORS.CONTRACT_MISMATCH, message, error.data);
        case RPC.INVALID_PARAMS:
            return new CutReadyError(CANVAS_ERRORS.INVALID_REQUEST, message, error.data);
        default:
            return new CutReadyError(CANVAS_ERRORS.PROTOCOL, message, { rpcCode: error?.code });
    }
}

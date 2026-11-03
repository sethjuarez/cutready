// The loopback HTTP server behind every canvas panel: static web assets, a
// token-gated JSON API, and server-sent events. It binds 127.0.0.1 only,
// checks Host (DNS rebinding) and Origin, and takes JSON bodies only.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { CutReadyError } from "./errors.mjs";

const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
};
const MAX_BODY = 8 * 1024 * 1024;
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors *";
const CONFLICT = ["stale_document", "stale_review", "undo_conflict", "locked_document", "locked_row", "locked_row_count", "locked_cell"];
const STATUS = {
    invalid_request: 400,
    no_project: 400,
    document_not_found: 404,
    ...Object.fromEntries(CONFLICT.map((code) => [code, 409])),
    cli_not_found: 503,
    contract_mismatch: 503,
    handshake_failed: 503,
    process_exited: 503,
    protocol_error: 502,
    timeout: 504,
};

/**
 * @param {object} options
 * @param {string} options.webRoot folder of static assets
 * @param {import("./instances.mjs").Instances} options.instances
 * @param {Record<string, (instance, input) => Promise<unknown>>} options.routes "METHOD /path" → handler
 * @param {(message: string) => void} [options.log]
 */
export async function startServer({ webRoot, instances, routes, log = () => {} }) {
    const root = path.resolve(webRoot);
    let origin;
    const server = createServer((req, res) => {
        handle(req, res).catch((err) => {
            log(`cutready-canvas: ${err?.stack || err}`);
            if (!res.headersSent) send(res, 500, { error: { code: "internal", message: "Internal error" } });
            else res.destroy();
        });
    });

    async function handle(req, res) {
        if (req.headers.host !== new URL(origin).host) return send(res, 421, { error: { code: "bad_host", message: "Wrong host" } });
        const url = new URL(req.url, origin);
        if (url.pathname === "/events") return events(req, res, url);
        if (url.pathname.startsWith("/api/")) return api(req, res, url);
        if (req.method !== "GET") return send(res, 405, { error: { code: "method", message: "Method not allowed" } });
        return serveStatic(res, url.pathname);
    }

    function authorize(req, res, token) {
        const instance = instances.byToken(token);
        if (!instance) send(res, 401, { error: { code: "unauthorized", message: "This canvas was closed; reopen it" } });
        return instance;
    }

    async function api(req, res, url) {
        const route = routes[`${req.method} ${url.pathname}`];
        if (!route) return send(res, 404, { error: { code: "not_found", message: "No such endpoint" } });
        if (req.headers.origin && req.headers.origin !== origin) {
            return send(res, 403, { error: { code: "bad_origin", message: "Cross-origin request refused" } });
        }
        const instance = authorize(req, res, req.headers["x-cutready-token"]);
        if (!instance) return;
        let input = Object.fromEntries(url.searchParams);
        if (req.method === "POST") {
            if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
                return send(res, 415, { error: { code: "invalid_request", message: "Send JSON" } });
            }
            try {
                input = JSON.parse(await readBody(req));
            } catch (err) {
                return send(res, 400, { error: { code: "invalid_request", message: err.message } });
            }
        }
        try {
            send(res, 200, await route(instance, input ?? {}));
        } catch (err) {
            if (!(err instanceof CutReadyError)) {
                log(`cutready-canvas: ${err?.stack || err}`);
                return send(res, 500, { error: { code: "internal", message: "Internal error" } });
            }
            send(res, STATUS[err.code] ?? 422, { error: err.toJSON() });
        }
    }

    function events(req, res, url) {
        const instance = authorize(req, res, url.searchParams.get("token"));
        if (!instance) return;
        res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            connection: "keep-alive",
            "x-content-type-options": "nosniff",
        });
        const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        write("hello", { project: instance.project, focus: instance.focus ?? null });
        const unsubscribe = instances.subscribe(instance, (event, data) => {
            write(event, data);
            if (event === "closed") res.end();
        });
        req.on("close", unsubscribe);
    }

    async function serveStatic(res, pathname) {
        const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
        const file = path.resolve(root, relative);
        const type = TYPES[path.extname(file)];
        if (!type || (file !== root && !file.startsWith(root + path.sep))) {
            return send(res, 404, { error: { code: "not_found", message: "Not found" } });
        }
        let body;
        try {
            body = await readFile(file);
        } catch {
            return send(res, 404, { error: { code: "not_found", message: "Not found" } });
        }
        res.writeHead(200, {
            "content-type": type,
            "cache-control": "no-store",
            "content-security-policy": CSP,
            "x-content-type-options": "nosniff",
        });
        res.end(body);
    }

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;

    return {
        origin,
        /** The panel URL for an instance; the token rides in the query string. */
        urlFor: (instance) => `${origin}/?token=${encodeURIComponent(instance.token)}`,
        close: () =>
            new Promise((resolve) => {
                server.closeAllConnections?.();
                server.close(() => resolve());
            }),
    };
}

function send(res, status, body) {
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify(body));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                reject(new Error("Request body too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

// The panel's client for the canvas server: JSON calls carrying the panel
// token, and server-sent events. Errors reject with `{ code, message, details }`.
const token = new URLSearchParams(location.search).get("token") ?? "";

export class ApiError extends Error {
    constructor({ code, message, details }) {
        super(message);
        this.code = code;
        this.details = details;
    }
}

async function call(method, path, body) {
    let response;
    try {
        response = await fetch(path, {
            method,
            headers: { "x-cutready-token": token, ...(body ? { "content-type": "application/json" } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
    } catch (err) {
        throw new ApiError({ code: "canvas_offline", message: "The canvas server isn't reachable; reopen the canvas" });
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(payload.error ?? { code: "http_" + response.status, message: response.statusText });
    return payload;
}

export const api = {
    project: () => call("GET", "/api/project"),
    documents: () => call("GET", "/api/documents"),
    document: (path) => call("GET", `/api/document?path=${encodeURIComponent(path)}`),
    edit: (path, expectedVersion, ops) => call("POST", "/api/edit", { path, expectedVersion, ops }),
    reviews: () => call("GET", "/api/reviews"),
    resolve: (decision, item) =>
        call("POST", "/api/review", { decision, runId: item.run_id, path: item.path, throughSeq: item.through_seq }),
};

/** Calls `onEvent(name, data)` for each server event; EventSource reconnects on its own. */
export function subscribe(onEvent) {
    const source = new EventSource(`/events?token=${encodeURIComponent(token)}`);
    for (const name of ["hello", "changed", "focus", "closed"]) {
        source.addEventListener(name, (event) => onEvent(name, JSON.parse(event.data)));
    }
    return () => source.close();
}

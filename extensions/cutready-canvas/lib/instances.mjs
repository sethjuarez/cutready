// Open canvas panels. Each instance shows one project, has its own URL token,
// and gets server-sent events when an agent action changes or focuses
// something, so the panel refreshes without polling.
import { randomBytes } from "node:crypto";
import { CANVAS_ERRORS } from "./contract.mjs";
import { CutReadyError } from "./errors.mjs";

export class Instances {
    #byId = new Map();
    #byToken = new Map();
    #sessions;

    /** @param {import("./projectSessions.mjs").ProjectSessions} sessions */
    constructor(sessions) {
        this.#sessions = sessions;
    }

    /**
     * Registers (or re-points) a panel. Reopening the same id on the same
     * project keeps its token, so a rehydrated iframe keeps working; moving it
     * to another project rotates the token and drops old listeners, so a URL
     * issued for one project never reaches another.
     */
    open(instanceId, { project, cliPath }) {
        const session = this.#sessions.get(project, { cliPath });
        let instance = this.#byId.get(instanceId);
        if (instance && instance.project !== session.root) {
            this.close(instanceId);
            instance = undefined;
        }
        if (!instance) {
            instance = { id: instanceId, token: randomBytes(24).toString("base64url"), listeners: new Set(), focus: undefined };
            this.#byId.set(instanceId, instance);
            this.#byToken.set(instance.token, instance);
        }
        instance.session = session;
        instance.project = session.root;
        return instance;
    }

    get(instanceId) {
        const instance = this.#byId.get(instanceId);
        if (!instance) {
            throw new CutReadyError(CANVAS_ERRORS.INVALID_REQUEST, `No open CutReady canvas ${instanceId}; open one first`);
        }
        return instance;
    }

    byToken(token) {
        return typeof token === "string" ? this.#byToken.get(token) : undefined;
    }

    /** Every open panel on the same project as `instance` hears `event`. */
    emit(instance, event, data = {}) {
        if (event === "focus") instance.focus = data.path;
        for (const other of this.#byId.values()) {
            if (other.project !== instance.project) continue;
            if (event === "focus" && other !== instance) continue;
            for (const listener of other.listeners) listener(event, data);
        }
    }

    subscribe(instance, listener) {
        instance.listeners.add(listener);
        return () => instance.listeners.delete(listener);
    }

    close(instanceId) {
        const instance = this.#byId.get(instanceId);
        if (!instance) return;
        this.#byId.delete(instanceId);
        this.#byToken.delete(instance.token);
        for (const listener of instance.listeners) listener("closed", {});
        instance.listeners.clear();
        const stillUsed = [...this.#byId.values()].some((other) => other.project === instance.project);
        if (!stillUsed) this.#sessions.release(instance.project);
    }
}

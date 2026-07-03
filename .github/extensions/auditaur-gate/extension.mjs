// Extension: auditaur-gate
// Auditaur manual gate canvas

import { createServer } from "node:http";
import { writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const servers = new Map();

const gateSchema = {
    type: "object",
    properties: {
        name: { type: "string" },
        instructions: { type: "string" },
        selector: { type: ["string", "null"] },
        expectText: { type: ["string", "null"] },
        timeoutMs: { type: "integer", minimum: 1 },
        manualContinue: { type: "boolean" },
        choices: {
            type: "array",
            items: {
                type: "object",
                required: ["id", "label"],
                properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                    outcome: {
                        type: "string",
                        enum: ["continue", "retry", "skip", "fail", "abort"],
                    },
                },
                additionalProperties: false,
            },
        },
        inputs: {
            type: "array",
            items: {
                type: "object",
                required: ["id", "label"],
                properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                    kind: { type: "string", enum: ["text", "multilineText"] },
                    required: { type: "boolean" },
                    sensitive: { type: "boolean" },
                },
                additionalProperties: false,
            },
        },
        clipboard: {
            type: ["object", "null"],
            required: ["label", "value"],
            properties: {
                label: { type: "string" },
                value: { type: "string" },
                sensitive: { type: "boolean" },
                copy: { type: "string", enum: ["attempt", "manualOnly", "disabled"] },
            },
            additionalProperties: true,
        },
    },
    required: ["name", "instructions"],
    additionalProperties: true,
};

const gateRequestSchema = {
    type: "object",
    properties: {
        requestId: { type: "string" },
        runId: { type: "string" },
        gateId: { type: "string" },
        attempt: { type: "integer" },
        nonce: { type: "string" },
        session: { type: "object", additionalProperties: true },
        prompt: {
            type: "object",
            required: ["name", "instructions"],
            properties: {
                name: { type: "string" },
                instructions: { type: "string" },
                selector: { type: ["string", "null"] },
                expectText: { type: ["string", "null"] },
                timeoutMs: { type: "integer", minimum: 1 },
                manualContinue: { type: "boolean" },
            },
            additionalProperties: true,
        },
        choices: gateSchema.properties.choices,
        inputs: gateSchema.properties.inputs,
        clipboard: { type: ["object", "null"], additionalProperties: true },
    },
    required: ["prompt"],
    additionalProperties: true,
};

function defaultGate() {
    return {
        requestId: "preview-human-action",
        runId: "drill-preview",
        gateId: "human-action",
        attempt: 1,
        nonce: "preview-nonce",
        session: {
            serviceName: "example-app",
            sessionId: "preview-session",
            instanceId: "preview-instance",
            pid: 4242,
            databasePath: "C:\\Users\\you\\AppData\\Local\\auditaur\\sessions\\preview\\telemetry.sqlite",
        },
        prompt: {
            name: "Human action required",
            instructions:
                "Complete the requested manual action, then choose the outcome below.",
            manualContinue: true,
            selector: "#status",
            expectText: "Ready",
            timeoutMs: 300000,
        },
        clipboard: {
            label: "Value to copy",
            value: "[REDACTED]",
            sensitive: true,
            redacted: true,
            copy: "attempt",
            status: "copied",
        },
        choices: [
            { id: "done", label: "Done", outcome: "continue" },
            { id: "retry", label: "Retry", outcome: "retry" },
            { id: "skip", label: "Skip", outcome: "skip" },
            { id: "failed", label: "Failed", outcome: "fail" },
            { id: "abort", label: "Abort drill", outcome: "abort" },
        ],
        inputs: [
            {
                id: "note",
                label: "Human action note",
                kind: "multilineText",
                required: false,
                sensitive: true,
            },
        ],
    };
}

function gateFromInput(input) {
    if (!input || typeof input !== "object") {
        return defaultGate();
    }
    if (!input.prompt && (input.name || input.instructions)) {
        const gate = defaultGate();
        return {
            ...gate,
            requestId: input.requestId ?? gate.requestId,
            gateId: input.gateId ?? slugify(input.name ?? gate.gateId),
            prompt: {
                name: input.name ?? gate.prompt.name,
                instructions: input.instructions ?? gate.prompt.instructions,
                selector: input.selector ?? null,
                expectText: input.expectText ?? null,
                timeoutMs: input.timeoutMs ?? gate.prompt.timeoutMs,
                manualContinue: input.manualContinue ?? gate.prompt.manualContinue,
            },
            choices: Array.isArray(input.choices) ? input.choices : [],
            inputs: Array.isArray(input.inputs) ? input.inputs : [],
            clipboard: input.clipboard ?? null,
        };
    }
    return {
        ...defaultGate(),
        ...input,
        prompt: { ...defaultGate().prompt, ...(input.prompt ?? {}) },
        session: { ...defaultGate().session, ...(input.session ?? {}) },
        choices: Array.isArray(input.choices) ? input.choices : defaultGate().choices,
        inputs: Array.isArray(input.inputs) ? input.inputs : defaultGate().inputs,
        clipboard: input.clipboard === null ? null : { ...defaultGate().clipboard, ...(input.clipboard ?? {}) },
    };
}

function slugify(value) {
    return String(value ?? "human-action")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "human-action";
}

function htmlEscape(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function jsonResponse(res, value, status = 200) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
}

function normalizeResponseInputs(inputs) {
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
        return [];
    }
    return Object.entries(inputs).map(([id, value]) => ({
        id,
        value: String(value ?? ""),
    }));
}

function canPublishGateResponse(gate) {
    return Boolean(
        gate?.responsePath &&
            gate?.requestId &&
            gate?.runId &&
            gate?.gateId &&
            gate?.nonce &&
            Number.isInteger(gate?.attempt)
    );
}

async function writeJsonAtomic(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
    await rename(tempPath, path);
}

async function publishGateResponse(gate, body) {
    if (!canPublishGateResponse(gate)) {
        return null;
    }
    const response = {
        schemaVersion: 1,
        requestId: gate.requestId,
        runId: gate.runId,
        gateId: gate.gateId,
        attempt: gate.attempt,
        nonce: gate.nonce,
        responder: body.responder ?? "human-confirmed-via-copilot-canvas",
        choiceId: body.choiceId ?? null,
        inputs: normalizeResponseInputs(body.inputs),
    };
    await writeJsonAtomic(gate.responsePath, response);
    return {
        status: "published",
        responsePath: gate.responsePath,
        requestId: gate.requestId,
    };
}

function renderInput(input) {
    const id = htmlEscape(input.id);
    const required = input.required ? "required aria-required=\"true\"" : "";
    const describedBy = `${id}-hint`;
    const sensitivity = input.sensitive
        ? "Sensitive. Auditaur redacts this value in reports."
        : "Recorded in the drill report.";
    const requiredBadge = input.required ? `<span class="badge danger">Required</span>` : `<span class="badge">Optional</span>`;
    const sensitiveBadge = input.sensitive ? `<span class="badge warning">Sensitive</span>` : `<span class="badge">Recorded</span>`;
    const label = `<span class="field-label">${htmlEscape(input.label)} ${requiredBadge} ${sensitiveBadge}</span>`;
    if (input.kind === "multilineText") {
        return `<label class="field">
            ${label}
            <textarea name="${id}" ${required} aria-describedby="${describedBy}" placeholder="${htmlEscape(sensitivity)}"></textarea>
            <span id="${describedBy}" class="help">${htmlEscape(sensitivity)}</span>
        </label>`;
    }
    return `<label class="field">
        ${label}
        <input name="${id}" ${required} aria-describedby="${describedBy}" placeholder="${htmlEscape(sensitivity)}" />
        <span id="${describedBy}" class="help">${htmlEscape(sensitivity)}</span>
    </label>`;
}

function gateMode(gate) {
    const prompt = gate.prompt ?? {};
    const hasWait = Boolean(prompt.selector);
    const hasChoices = Array.isArray(gate.choices) && gate.choices.length > 0;
    const hasInputs = Array.isArray(gate.inputs) && gate.inputs.length > 0;
    const hasManual = Boolean(prompt.manualContinue || hasChoices || hasInputs);
    if (hasWait && !hasManual) {
        return {
            id: "monitoring",
            eyebrow: "Auditaur monitored wait",
            title: "Auditaur is watching for the condition",
            description: "No manual response is needed unless the drill times out or the condition never appears.",
        };
    }

    if (hasWait && hasManual) {
        return {
            id: "mixed",
            eyebrow: "Manual gate with watched condition",
            title: "Complete the action or wait for Auditaur",
            description: "Auditaur is watching the app while a human response remains available.",
        };
    }
    return {
        id: "manual",
        eyebrow: "Manual drill gate",
        title: "Human action required",
        description: "Complete the requested action, then choose the outcome that best matches what happened.",
    };
}

function statusForGate(gate, lastResponse) {
    if (lastResponse) {
        return "Response staged";
    }
    const mode = gateMode(gate);
    if (mode.id === "monitoring") {
        return "Monitoring app condition";
    }
    if (mode.id === "mixed") {
        return "Watching condition and awaiting action";
    }
    return "Waiting for human action";
}

function renderHeader(gate, mode) {
    const prompt = gate.prompt ?? {};
    return `<header class="section hero mode-${mode.id}">
      <div class="eyebrow">${htmlEscape(mode.eyebrow)}</div>
      <h1>${htmlEscape(prompt.name)}</h1>
      <p class="instructions">${htmlEscape(prompt.instructions)}</p>
      <p class="mode-note">${htmlEscape(mode.description)}</p>
    </header>`;
}

function renderEvidenceContext(gate) {
    const session = gate.session ?? {};
    return `<details class="section evidence">
      <summary>Evidence context</summary>
      <div class="meta">
        <div class="meta-card"><span>Responder recorded as</span><strong>human-confirmed-via-copilot-canvas</strong></div>
        <div class="meta-card"><span>Service</span><strong>${htmlEscape(session.serviceName ?? "unknown")}</strong></div>
        <div class="meta-card"><span>Session</span><code>${htmlEscape(session.sessionId ?? "not attached")}</code></div>
        <div class="meta-card"><span>Request</span><code>${htmlEscape(gate.requestId ?? "preview")}</code></div>
        ${session.databasePath ? `<div class="meta-card wide"><span>Database</span><code>${htmlEscape(session.databasePath)}</code></div>` : ""}
      </div>
    </details>`;
}

function renderWaitCondition(gate, mode) {
    const prompt = gate.prompt ?? {};
    if (!prompt.selector) {
        return "";
    }
    return `<section class="section wait mode-${mode.id}" aria-labelledby="wait-title">
      <div>
        <div class="section-label" id="wait-title">Auditaur watch condition</div>
        <p>${mode.id === "monitoring" ? "The drill can proceed automatically when this condition is satisfied." : "This condition is observed in parallel with the manual response."}</p>
      </div>
      <div class="condition">
        <code>${htmlEscape(prompt.selector)}</code>
        ${prompt.expectText ? `<span>contains</span><code>${htmlEscape(prompt.expectText)}</code>` : `<span>returns text</span>`}
      </div>
    </section>`;
}

function renderClipboard(clipboard) {
    if (!clipboard) {
        return "";
    }
    const sensitivity = clipboard.sensitive ? "Sensitive value; redacted in report." : "Visible value.";
    return `<section class="section clipboard" aria-labelledby="clipboard-title">
      <div class="section-label" id="clipboard-title">${htmlEscape(clipboard.label ?? "Clipboard value")}</div>
      <p>${htmlEscape(sensitivity)} Copy mode: <code>${htmlEscape(clipboard.copy ?? "attempt")}</code>.</p>
      <div class="copy-value"><code>${htmlEscape(clipboard.sensitive ? "[REDACTED]" : clipboard.value ?? "[not shown]")}</code></div>
    </section>`;
}

function renderInputs(inputs) {
    if (!inputs.length) {
        return "";
    }
    return `<section class="section" aria-labelledby="inputs-title">
      <div class="section-label" id="inputs-title">Requested context</div>
      <div class="grid">${inputs.map(renderInput).join("")}</div>
    </section>`;
}

function renderOutcomeActions(gate, choices, mode) {
    if (!choices.length) {
        if (mode.id === "monitoring") {
            return `<section class="section quiet-state" aria-live="polite">
              <strong>Waiting on app evidence</strong>
              <p>Auditaur will continue when the selector condition is satisfied. No button is required for this gate shape.</p>
            </section>`;
        }
        return "";
    }
    return `<section class="section" aria-labelledby="actions-title">
      <div class="section-label" id="actions-title">Choose outcome</div>
      <form id="gate-form" class="grid">
        <div class="choices">
          ${choices.map(renderChoiceButton).join("")}
        </div>
      </form>
    </section>`;
}

function renderChoiceButton(choice) {
    const outcome = choice.outcome ?? "continue";
    const klass = outcome === "continue" ? "primary" : outcome === "fail" || outcome === "abort" ? "danger" : outcome === "skip" ? "warning" : "neutral";
    const outcomeCopy = {
        continue: "Resume drill",
        retry: "Try this gate again",
        skip: "Skip this gate",
        fail: "Fail this drill",
        abort: "Abort this drill",
    }[outcome] ?? outcome;
    return `<button class="${klass}" type="submit" name="choice" value="${htmlEscape(choice.id)}" aria-label="${htmlEscape(`${choice.label}: ${outcomeCopy}`)}">
      <span>${htmlEscape(choice.label)}</span>
      <small>${htmlEscape(outcomeCopy)}</small>
    </button>`;
}

function renderResponseStatus(lastResponse) {
    if (!lastResponse) {
        return `<p class="help footer-note">This prototype stages the response in the canvas. Live-drill wiring will submit the same shape through Auditaur MCP.</p>`;
    }
    return `<div class="section status" role="status" aria-live="polite">
      <strong>Response staged</strong>
      <p>Choice: <code>${htmlEscape(lastResponse.choiceId)}</code></p>
      <p>Responder: <code>${htmlEscape(lastResponse.responder)}</code></p>
    </div>`;
}

function renderHtml(instanceId, state) {
    const gate = state.gate;
    const mode = gateMode(gate);
    const clipboard = gate.clipboard;
    const choices = normalizeChoices(gate);
    const inputs = Array.isArray(gate.inputs) ? gate.inputs : [];
    const lastResponse = state.lastResponse;

    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Auditaur Manual Gate</title>
  <style>
    :root {
      color-scheme: light dark;
      --surface: var(--background-color-default, #ffffff);
      --surface-muted: var(--background-color-muted, #f6f8fa);
      --surface-overlay: var(--background-color-overlay, var(--surface));
      --border: var(--border-color-default, #d0d7de);
      --text: var(--text-color-default, #1f2328);
      --muted: var(--text-color-muted, #656d76);
      --accent: var(--true-color-blue, #0969da);
      --accent-muted: var(--true-color-blue-muted, #ddf4ff);
      --danger: var(--true-color-red, #cf222e);
      --danger-muted: var(--true-color-red-muted, #ffebe9);
      --warning: var(--true-color-yellow, #9a6700);
      --warning-muted: var(--true-color-yellow-muted, #fff8c5);
      --success: var(--true-color-green, #1a7f37);
      --success-muted: var(--true-color-green-muted, #dafbe1);
      --focus: var(--color-focus-outline, #0969da);
      --radius: 14px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--surface);
      color: var(--text);
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: var(--text-body-medium, 14px);
      line-height: var(--leading-body-medium, 20px);
    }
    main { padding: 18px; max-width: 780px; margin: 0 auto; }
    .section {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px;
      background: var(--surface-overlay);
      margin-block: 12px;
    }
    .hero { padding: 18px; box-shadow: 0 8px 30px rgb(0 0 0 / 8%); }
    .mode-manual { border-left: 4px solid var(--accent); }
    .mode-mixed { border-left: 4px solid var(--warning); }
    .mode-monitoring { border-left: 4px solid var(--success); }
    .eyebrow { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; font-weight: 700; }
    h1 { margin: 6px 0 10px; font-size: var(--text-title-large, 24px); line-height: var(--leading-title-large, 30px); }
    p { margin: 0; }
    .instructions { font-weight: var(--font-weight-semibold, 600); }
    .mode-note, .help, .footer-note { color: var(--muted); font-size: 13px; margin-top: 6px; }
    .grid { display: grid; gap: 12px; margin-top: 14px; }
    .meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 8px;
    }
    .meta-card, .condition, .copy-value {
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--surface-muted);
      padding: 10px 12px;
    }
    .meta-card.wide { grid-column: 1 / -1; }
    .meta-card span { display: block; color: var(--muted); font-size: 12px; }
    .section-label { font-weight: var(--font-weight-semibold, 600); margin-bottom: 4px; }
    code { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace); font-size: 12px; overflow-wrap: anywhere; }
    summary { cursor: pointer; font-weight: var(--font-weight-semibold, 600); }
    .condition { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
    .clipboard { border-left: 4px solid var(--accent); }
    .choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; }
    button {
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 10px 12px;
      background: var(--surface);
      color: var(--text);
      font: inherit;
      cursor: pointer;
      text-align: left;
      min-height: 48px;
    }
    button:hover, button:focus-visible { border-color: var(--focus); outline: 2px solid color-mix(in srgb, var(--focus) 35%, transparent); outline-offset: 1px; }
    button.primary { background: var(--accent); border-color: var(--accent); color: white; }
    button.danger { border-color: color-mix(in srgb, var(--danger) 50%, var(--border)); background: color-mix(in srgb, var(--danger-muted) 60%, var(--surface)); }
    button.warning { border-color: color-mix(in srgb, var(--warning) 50%, var(--border)); background: color-mix(in srgb, var(--warning-muted) 60%, var(--surface)); }
    button.neutral { background: var(--surface-muted); }
    button small { display: block; opacity: .8; }
    .field { display: grid; gap: 6px; }
    .field-label { font-weight: var(--font-weight-semibold, 600); }
    .badge { display: inline-block; border: 1px solid var(--border); border-radius: 999px; color: var(--muted); font-size: 11px; font-weight: 600; margin-left: 4px; padding: 0 6px; }
    .badge.danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, var(--border)); }
    .badge.warning { color: var(--warning); border-color: color-mix(in srgb, var(--warning) 35%, var(--border)); }
    input, textarea {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 10px 12px;
      background: var(--surface);
      color: var(--text);
      font: inherit;
    }
    textarea { min-height: 92px; resize: vertical; }
    .status {
      border: 1px solid color-mix(in srgb, var(--success) 35%, var(--border));
      background: color-mix(in srgb, var(--success-muted) 60%, var(--surface));
    }
    .quiet-state { background: color-mix(in srgb, var(--success-muted) 55%, var(--surface)); }
    .muted { color: var(--muted); }
  </style>
</head>
<body>
  <main>
    ${renderHeader(gate, mode)}
    ${renderWaitCondition(gate, mode)}
    ${renderClipboard(clipboard)}
    ${renderInputs(inputs)}
    ${renderOutcomeActions(gate, choices, mode)}
    ${renderEvidenceContext(gate)}
    ${renderResponseStatus(lastResponse)}
  </main>
  <script>
    const form = document.getElementById("gate-form");
    if (form) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const submitter = event.submitter;
        const data = new FormData(form);
        const inputs = {};
        for (const [key, value] of data.entries()) {
          if (key !== "choice") inputs[key] = value;
        }
        await fetch("/respond", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            choiceId: submitter?.value ?? data.get("choice"),
            inputs,
            responder: "human-confirmed-via-copilot-canvas"
          })
        });
        window.location.reload();
      });
    }
  </script>
</body>
</html>`;
}

function normalizeChoices(gate) {
    const choices = Array.isArray(gate.choices) ? gate.choices : [];
    if (choices.length > 0) {
        return choices.map((choice) => ({
            ...choice,
            outcome: choice.outcome ?? "continue",
        }));
    }
    if (gate.prompt?.manualContinue || (Array.isArray(gate.inputs) && gate.inputs.length > 0)) {
        return [{ id: "__manual_continue", label: "Continue", outcome: "continue" }];
    }
    return [];
}

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? JSON.parse(text) : {};
}

async function startServer(instanceId, state) {
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            if (req.method === "GET" && url.pathname === "/state") {
                jsonResponse(res, state);
                return;
            }
            if (req.method === "POST" && url.pathname === "/respond") {
                const body = await readBody(req);
                const publish = await publishGateResponse(state.gate, body);
                state.lastResponse = {
                    ...body,
                    publish,
                };
                jsonResponse(res, { ok: true, response: state.lastResponse, publish });
                return;
            }
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
            res.end(renderHtml(instanceId, state));
            return;
        } catch (error) {
            if (!res.headersSent) {
                jsonResponse(res, { error: String(error?.message ?? error) }, 500);
            } else {
                res.end();
            }
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/`, state };
}

await joinSession({
    canvases: [
        createCanvas({
            id: "auditaur-human-gate",
            displayName: "Auditaur Manual Gate",
            description: "Render any Auditaur drill human/manual gate schema as a Copilot action card.",
            inputSchema: { oneOf: [gateSchema, gateRequestSchema] },
            actions: [
                {
                    name: "set_gate",
                    description: "Replace the displayed gate payload with a DrillGate object or published gate request.",
                    inputSchema: { oneOf: [gateSchema, gateRequestSchema] },
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) {
                            return { ok: false, reason: "canvas instance is not open" };
                        }
                        entry.state.gate = gateFromInput(ctx.input);
                        entry.state.lastResponse = null;
                        return { ok: true, requestId: entry.state.gate.requestId };
                    },
                },
                {
                    name: "get_response",
                    description: "Read the response currently staged by the canvas UI.",
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        return { ok: Boolean(entry), response: entry?.state.lastResponse ?? null };
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    const state = {
                        gate: gateFromInput(ctx.input),
                        lastResponse: null,
                    };
                    entry = await startServer(ctx.instanceId, state);
                    servers.set(ctx.instanceId, entry);
                } else if (ctx.input && Object.keys(ctx.input).length > 0) {
                    entry.state.gate = gateFromInput(ctx.input);
                    entry.state.lastResponse = null;
                }
                return {
                    title: entry.state.gate.prompt?.name ?? "Auditaur Manual Gate",
                    status: statusForGate(entry.state.gate, entry.state.lastResponse),
                    url: entry.url,
                };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});

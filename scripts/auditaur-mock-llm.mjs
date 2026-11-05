#!/usr/bin/env node
// Scripted OpenAI-compatible model for chat drills. Binds 127.0.0.1 only, writes
// its port to --port-file, and logs one JSON line per request to --log.
//
//   node scripts/auditaur-mock-llm.mjs --port-file <path> --log <path> --token <secret> [--lifetime-ms <ms>]
//
// POST /__drill/shutdown with header x-drill-token: <secret> stops it, so teardown never
// has to trust a pid that may have been reused. Bodies over 32 MB and runs past 500
// requests are refused so a runaway client fails fast instead of filling the disk.
//
// Replies are chosen from the latest user message, so retries and side calls
// (titles, summaries) get a harmless default:
//   MOCK:read-note <path>  -> a read_note tool call; the follow-up turn echoes the tool result
//   MOCK:slow              -> a long stream (cancellation drills)
//   MOCK:error             -> HTTP 500
//   a ✨ Suggest request   -> {"name": "Mock version name" | "Mock merge name", "comment": ...}
//   anything else          -> "MOCK-REPLY-OK"

import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const flags = {};
for (let i = 2; i < process.argv.length; i += 2) flags[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
if (!flags["port-file"] || !flags.log || !flags.token) {
  console.error("usage: auditaur-mock-llm.mjs --port-file <path> --log <path> --token <secret> [--lifetime-ms <ms>]");
  process.exit(2);
}

const MODEL = "drill-mock";
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_REQUESTS = 500;
let requests = 0;
// Exits on its own if teardown never runs (e.g., the drill runner was killed).
setTimeout(() => process.exit(0), Number(flags["lifetime-ms"] ?? 3_600_000)).unref();

const server = createServer(async (req, res) => {
  const path = (req.url ?? "").split("?")[0].replace(/^\/v1/, "");
  if (req.method === "POST" && path === "/__drill/shutdown") {
    if (req.headers["x-drill-token"] !== flags.token) return json(res, 403, { error: { message: "bad token" } });
    res.writeHead(200, { "content-type": "application/json" });
    return res.end('{"ok":true}', () => process.exit(0));
  }
  if (++requests > MAX_REQUESTS) {
    if (requests === MAX_REQUESTS + 1) log({ path, refused: "too many requests" });
    return json(res, 503, { error: { message: `mock refuses more than ${MAX_REQUESTS} requests` } });
  }
  const body = await readBody(req);
  if (body === null) {
    log({ path, refused: "body too large" });
    return json(res, 413, { error: { message: "request body too large" } });
  }
  if (req.method === "GET" && path === "/models") {
    log({ path, method: req.method });
    return json(res, 200, { object: "list", data: [{ id: MODEL, object: "model", owned_by: "auditaur-drill" }] });
  }
  if (req.method !== "POST" || path !== "/chat/completions") {
    log({ path, method: req.method, unhandled: true });
    return json(res, 404, { error: { message: `mock does not serve ${req.method} ${req.url}` } });
  }

  let request;
  try {
    request = JSON.parse(body);
  } catch {
    return json(res, 400, { error: { message: "invalid JSON" } });
  }
  const messages = request.messages ?? [];
  const last = messages.at(-1);
  const userText = textOf([...messages].reverse().find((message) => message.role === "user"));
  const systemText = textOf(messages.find((message) => message.role === "system"));
  const suggest = systemText.startsWith("You name versions") ? "version" : systemText.startsWith("You name merges") ? "merge" : undefined;
  log({
    path,
    suggest,
    model: request.model,
    stream: Boolean(request.stream),
    tools: (request.tools ?? []).map((tool) => tool.function?.name ?? tool.name),
    lastRole: last?.role,
    toolResult: last?.role === "tool" ? textOf(last).slice(0, 2000) : undefined,
    authorized: req.headers.authorization === `Bearer ${process.env.OPENAI_API_KEY}`,
  });

  if (/MOCK:error/.test(userText)) return json(res, 500, { error: { message: "MOCK-PROVIDER-ERROR", type: "server_error" } });
  if (last?.role === "tool") return reply(res, request, { text: `MOCK-TOOL-RESULT ${textOf(last).slice(0, 400)}` });
  if (suggest === "version") return reply(res, request, { text: JSON.stringify({ name: "Mock version name", comment: "Mock version comment." }) });
  if (suggest === "merge") return reply(res, request, { text: JSON.stringify({ name: "Mock merge name", comment: "Mock merge comment." }) });
  const readNote = userText.match(/MOCK:read-note\s+(\S+)/);
  if (readNote) return reply(res, request, { toolCall: { name: "read_note", args: { path: readNote[1] } } });
  if (/MOCK:slow/.test(userText)) return reply(res, request, { text: "MOCK-SLOW ".repeat(600), delayMs: 100, chunk: 10, tag: "slow" });
  return reply(res, request, { text: "MOCK-REPLY-OK" });
});

server.listen(0, "127.0.0.1", () => {
  writeFileSync(flags["port-file"], String(server.address().port));
});

function reply(res, request, { text, toolCall, delayMs = 0, chunk = 40, tag }) {
  const id = `chatcmpl-drill-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const toolCalls = toolCall
    ? [{ index: 0, id: `call_drill_${Date.now()}`, type: "function", function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) } }]
    : undefined;
  const finish = toolCall ? "tool_calls" : "stop";
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

  if (!request.stream) {
    const message = { role: "assistant", content: toolCall ? null : text, ...(toolCalls ? { tool_calls: toolCalls.map(({ index, ...call }) => call) } : {}) };
    return json(res, 200, { id, object: "chat.completion", created, model: MODEL, choices: [{ index: 0, message, finish_reason: finish }], usage });
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  let closed = false;
  res.on("close", () => { closed = true; });
  const send = (delta, finishReason = null, extra = {}) =>
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: MODEL, choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra })}\n\n`);
  const pieces = toolCall ? [] : (text.match(new RegExp(`[\\s\\S]{1,${chunk}}`, "g")) ?? []);
  (async () => {
    send({ role: "assistant", content: toolCall ? null : "" });
    if (toolCalls) send({ tool_calls: toolCalls });
    for (const piece of pieces) {
      if (closed) return log({ path: "/chat/completions", aborted: true, tag });
      send({ content: piece });
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (closed) return;
    if (tag) log({ path: "/chat/completions", completed: true, tag });
    send({}, finish);
    if (request.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: MODEL, choices: [], usage })}\n\n`);
    res.end("data: [DONE]\n\n");
  })();
}

function textOf(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.map((part) => part.text ?? "").join("");
  return "";
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    let size = 0;
    req.on("data", (piece) => {
      size += piece.length;
      if (size > MAX_BODY_BYTES) {
        req.removeAllListeners("data");
        req.resume();
        return resolve(null);
      }
      data += piece;
    });
    req.on("end", () => resolve(data));
  });
}

function log(entry) {
  appendFileSync(flags.log, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { trackRequests } from "../lib/take.js";

test("trackRequests waits for in-flight requests, then a quiet period", async () => {
  const page = new EventEmitter();
  const net = trackRequests(page);
  page.emit("request");
  setTimeout(() => page.emit("requestfinished"), 80);
  const started = Date.now();
  await net.quiet(50, 2000);
  assert.ok(Date.now() - started >= 120, "waited for the request and the quiet window");
  net.stop();
  assert.equal(page.listenerCount("request"), 0, "stops listening");
});

test("trackRequests gives up at the deadline", async () => {
  const page = new EventEmitter();
  const net = trackRequests(page);
  page.emit("request");
  const started = Date.now();
  await net.quiet(50, 150);
  const waited = Date.now() - started;
  assert.ok(waited >= 140 && waited < 1000, `waited ${waited} ms`);
});

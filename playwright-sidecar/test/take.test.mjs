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

test("browser.take logs a semantic witness for each step", { timeout: 60000 }, async () => {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");
  const { runTake } = await import("../lib/take.js");
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-witness-"));
  const fixture = url.pathToFileURL(path.resolve(import.meta.dirname, "../spike/fixture.html")).href;
  try {
    const { log } = await runTake({
      url: fixture,
      outDir,
      markers: { holdMs: 40, gapMs: 40, settleMs: 100 },
      steps: [
        { type: "click", label: "open", selectors: ["#open"], expect: { selector: "#panel" } },
        { type: "type", label: "type", selectors: ["#name"], text: "hi", delayMs: 20, expect: { selector: "#name", value: "hi" } },
      ],
    });
    const [, click, type] = log.steps;
    for (const step of [click, type]) {
      assert.equal(step.status, "ok", step.error);
      const w = step.witness;
      assert.ok(w.clock_pre.rtt_ms >= 0 && w.clock_post.rtt_ms >= 0);
      assert.ok(Math.abs(w.clock_pre.offset_ms - w.clock_post.offset_ms) < 20, "page clock is stable");
      const toHost = (ms) => ms + w.clock_pre.offset_ms;
      const input = w.events.find((e) => e.kind.startsWith("input:"));
      assert.ok(input, "input event");
      assert.ok(toHost(input.at) >= step.dispatched_ms - 5, "input after dispatch");
      const effect = w.events.find((e) => e.kind.startsWith("effect:") && e.at >= input.at);
      assert.ok(effect, `effect after input in ${JSON.stringify(w.events.map((e) => e.kind))}`);
      // rAF timestamps are frame-begin times, which can precede an event handled in that frame.
      assert.ok(effect.frame >= input.at - 17, "effect paints in or after the input frame");
    }
    assert.ok(click.witness.events.some((e) => e.kind === "input:pointerdown"));
    assert.ok(type.witness.events.some((e) => e.kind === "effect:input"));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

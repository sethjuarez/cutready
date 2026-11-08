/**
 * `browser.take`: drive a real page in a fresh, video-recording browser
 * context and log precise host-clock timings for every step.
 *
 * Timing model (all host stamps are process.hrtime.bigint()):
 *   - The context is created with recordVideo; the page (and therefore the
 *     video) starts at `page_created_at`. All `*_ms` fields are relative to it.
 *   - Each step logs dispatched_at (just before the Playwright input call),
 *     input_effect_at (after Playwright resolves the input), and
 *     postcondition_at (after the explicit expected state is observed).
 *   - Calibration markers flash a full-viewport magenta overlay. Each marker
 *     logs on_requested/on_ack (overlay inserted and two rAFs elapsed) and
 *     off_requested/off_ack, so video PTS edges can be matched to the host
 *     clock.
 */

import * as fs from "fs";
import * as path from "path";
import { chromium } from "playwright";

export const MARKER_COLOR = "#ff00ff";
export const MARKER_ID = "__cutready_calibration_marker";

const now = () => process.hrtime.bigint();
const relMs = (t0, t) => Number(t - t0) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * CSS for the marker overlay. By default it covers the whole viewport; with
 * `stripHeight` it is a fixed band at the bottom edge only, so a renderer
 * can crop it away and keep every frame of the page visible.
 */
export function markerCss(color, stripHeight) {
  const geometry = stripHeight ? `left:0;right:0;bottom:0;height:${stripHeight}px` : "inset:0";
  return `position:fixed;${geometry};z-index:2147483647;pointer-events:none;background:${color}`;
}

async function setMarker(page, visible, color, stripHeight) {
  return page.evaluate(
    async ({ visible, css, markerId }) => {
      const id = markerId;
      let el = document.getElementById(id);
      if (visible) {
        if (!el) {
          el = document.createElement("div");
          el.id = id;
          el.style.cssText = css;
          document.documentElement.appendChild(el);
        }
      } else if (el) {
        el.remove();
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return performance.now();
    },
    { visible, css: markerCss(color, stripHeight), markerId: MARKER_ID },
  );
}

export const WITNESS_BINDING = "__cutreadyWitness";
/** Effects are only reported this long after the document's last input. */
export const WITNESS_EFFECT_WINDOW_MS = 1500;

/**
 * Page-side semantic witness, installed in every document before page code
 * runs. It reports input events (pointerdown, keydown, wheel) and the first
 * effect per animation frame after an input (DOM mutation, input value,
 * scroll), plus each new document's first frame. Every event carries
 * page-clock times (`performance.timeOrigin + …`, epoch ms): `at` when it
 * happened and `frame` for the next animation frame, the earliest frame
 * that can paint it. The audit maps these through clock probes, so this is a
 * non-pixel clock for "when did the page change".
 */
export function witnessInit({ binding, markerId, effectWindowMs }) {
  if (window.__cutreadyWitnessInstalled) return;
  window.__cutreadyWitnessInstalled = true;
  const doc = `${performance.timeOrigin.toFixed(3)}-${Math.random().toString(36).slice(2, 8)}`;
  const send = (ev) => {
    try {
      window[binding]?.(ev);
    } catch {}
  };
  const boxOf = (node) => {
    const el = node && node.nodeType === 1 ? node : node?.parentElement;
    if (!el || el === document.documentElement || el === document.body) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  let lastInput = -Infinity;
  const pending = new Set();
  const report = (kind, node, at) => {
    if (kind.startsWith("effect:")) {
      if (at - lastInput > effectWindowMs || pending.has(kind)) return;
      pending.add(kind);
    }
    const box = boxOf(node);
    requestAnimationFrame((ts) => {
      pending.delete(kind);
      send({ doc, kind, at, frame: performance.timeOrigin + ts, box, url: location.href });
    });
  };
  const nowEpoch = () => performance.timeOrigin + performance.now();
  requestAnimationFrame((ts) =>
    send({ doc, kind: "document", at: performance.timeOrigin, frame: performance.timeOrigin + ts, box: null, url: location.href }),
  );
  for (const type of ["pointerdown", "keydown", "wheel"]) {
    addEventListener(
      type,
      (e) => {
        lastInput = nowEpoch();
        report(`input:${type}`, e.target, performance.timeOrigin + e.timeStamp);
      },
      { capture: true, passive: true },
    );
  }
  addEventListener("input", (e) => report("effect:input", e.target, nowEpoch()), { capture: true });
  addEventListener("scroll", (e) => report("effect:scroll", e.target === document ? null : e.target, nowEpoch()), {
    capture: true,
    passive: true,
  });
  const isMarker = (n) => n?.id === markerId;
  const observer = new MutationObserver((records) => {
    const real = records.find(
      (r) =>
        !isMarker(r.target) &&
        !(r.type === "childList" && [...r.addedNodes, ...r.removedNodes].every(isMarker)),
    );
    if (real) report("effect:mutation", real.target, nowEpoch());
  });
  const start = () =>
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  if (document.documentElement) start();
  else addEventListener("DOMContentLoaded", start, { once: true });
}

/**
 * Host↔page clock probe: the minimum-roundtrip of `samples` evaluations.
 * `offset_ms` maps page epoch ms to host ms (relative to t0).
 */
export async function clockProbe(page, t0, samples = 3) {
  let best = null;
  for (let i = 0; i < samples; i++) {
    const a = now();
    const p = await page.evaluate(() => [performance.timeOrigin + performance.now(), performance.timeOrigin]);
    const b = now();
    const rtt_ms = Number(b - a) / 1e6;
    const host_ms = relMs(t0, a) + rtt_ms / 2;
    if (!best || rtt_ms < best.rtt_ms) {
      best = { host_ms, page_ms: p[0], time_origin: p[1], rtt_ms, offset_ms: host_ms - p[0] };
    }
  }
  return best;
}

/** Flash the calibration overlay for ~holdMs and log host stamps. */
async function flashMarker(page, t0, label, { holdMs, gapMs, color, stripHeight }) {
  const on_requested_at = now();
  await setMarker(page, true, color, stripHeight);
  const on_ack_at = now();
  await sleep(holdMs);
  const off_requested_at = now();
  await setMarker(page, false, color, stripHeight);
  const off_ack_at = now();
  // Keep a gap so consecutive markers stay distinct runs in the video.
  await sleep(gapMs);
  return {
    label,
    on_requested_ms: relMs(t0, on_requested_at),
    on_ack_ms: relMs(t0, on_ack_at),
    off_requested_ms: relMs(t0, off_requested_at),
    off_ack_ms: relMs(t0, off_ack_at),
  };
}

/**
 * Resolve the first selector in `selectors` (in priority order) that is
 * visible, polling all candidates together so a stale preferred selector
 * doesn't cost a full timeout before the fallback is tried.
 */
async function resolveSelector(page, selectors, timeoutMs) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  const deadline = Date.now() + timeoutMs;
  do {
    for (const [i, sel] of list.entries()) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) {
        return { locator: loc, selector: sel, tried: i + 1 };
      }
    }
    await sleep(50);
  } while (Date.now() < deadline);
  throw new Error(`No selector matched within ${timeoutMs}ms: ${list.join(" | ")}`);
}

async function waitPostcondition(page, expect, timeoutMs) {
  if (!expect) return null;
  if (expect.url) {
    await page.waitForURL(new RegExp(expect.url), { timeout: timeoutMs });
    return `url~${expect.url}`;
  }
  if (expect.selector) {
    const state = expect.state || "visible";
    const loc = page.locator(expect.selector).first();
    if (expect.value !== undefined) {
      await page.waitForFunction(
        ({ sel, value }) => document.querySelector(sel)?.value === value,
        { sel: expect.selector, value: expect.value },
        { timeout: timeoutMs },
      );
      return `${expect.selector} value=${JSON.stringify(expect.value)}`;
    }
    await loc.waitFor({ state, timeout: timeoutMs });
    return `${expect.selector} ${state}`;
  }
  if (expect.scrollYAtLeast !== undefined) {
    await page.waitForFunction((y) => window.scrollY >= y, expect.scrollYAtLeast, { timeout: timeoutMs });
    return `scrollY>=${expect.scrollYAtLeast}`;
  }
  throw new Error(`Unsupported postcondition: ${JSON.stringify(expect)}`);
}

/** Viewport-space box of the first match, or null when absent/hidden. */
async function boxOf(page, selector) {
  if (!selector) return null;
  const box = await page.locator(selector).first().boundingBox({ timeout: 500 }).catch(() => null);
  return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
}

/**
 * Counts requests started from now on. `quiet(ms, maxMs)` resolves once none
 * has been in flight for `ms` (or after `maxMs`) and returns the time waited;
 * `stop()` detaches the listeners.
 */
export function trackRequests(page) {
  let inflight = 0;
  let lastChange = Date.now();
  const up = () => { inflight += 1; lastChange = Date.now(); };
  const down = () => { inflight = Math.max(0, inflight - 1); lastChange = Date.now(); };
  page.on("request", up);
  page.on("requestfinished", down);
  page.on("requestfailed", down);
  return {
    async quiet(ms, maxMs) {
      const started = Date.now();
      const deadline = started + maxMs;
      while (Date.now() < deadline && (inflight > 0 || Date.now() - lastChange < ms)) await sleep(25);
      return Date.now() - started;
    },
    stop() {
      page.off("request", up);
      page.off("requestfinished", down);
      page.off("requestfailed", down);
    },
  };
}

/**
 * Resolve, reveal and pre-arm the target before the step's settle window so
 * scrolling, hover styling and focus rings land before the reference frame
 * and the first visible change after dispatch is the action's own effect.
 */
async function prepare(page, step, timeoutMs) {
  if (step.type === "scroll") {
    // mouse.wheel scrolls whatever is under the pointer, which is wherever the
    // previous step left it (often a navbar or sidebar after a navigation).
    if (step.selectors?.length) {
      const { locator, selector, tried } = await resolveSelector(page, step.selectors, step.selectorTimeoutMs ?? 3000);
      await locator.hover({ timeout: timeoutMs });
      const box = await locator.boundingBox().catch(() => null);
      const target_box = box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
      return { locator, selector, selector_attempts: tried, target_box };
    }
    const vp = page.viewportSize() || { width: 1280, height: 720 };
    await page.mouse.move(Math.round(vp.width / 2), Math.round(vp.height / 2));
    return null;
  }
  if (step.type !== "click" && step.type !== "type") return null;
  const { locator, selector, tried } = await resolveSelector(page, step.selectors, step.selectorTimeoutMs ?? 3000);
  await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => {});
  if (step.type === "click") await locator.hover({ timeout: timeoutMs });
  else await locator.focus({ timeout: timeoutMs });
  const box = await locator.boundingBox().catch(() => null);
  const target_box = box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
  return { locator, selector, selector_attempts: tried, target_box };
}

async function dispatch(page, step, prepared, timeoutMs) {
  switch (step.type) {
    case "navigate": {
      const dispatched_at = now();
      await page.goto(step.url, { waitUntil: step.waitUntil || "load", timeout: timeoutMs });
      return { dispatched_at, input_effect_at: now(), selector: null };
    }
    case "click": {
      const dispatched_at = now();
      await prepared.locator.click({ timeout: timeoutMs });
      return { ...prepared, dispatched_at, input_effect_at: now() };
    }
    case "type": {
      const dispatched_at = now();
      await prepared.locator.pressSequentially(step.text, { delay: step.delayMs ?? 40, timeout: timeoutMs });
      return { ...prepared, dispatched_at, input_effect_at: now() };
    }
    case "scroll": {
      const dispatched_at = now();
      await page.mouse.wheel(step.dx ?? 0, step.dy ?? 600);
      return { ...(prepared || {}), dispatched_at, input_effect_at: now(), selector: prepared?.selector ?? null };
    }
    case "wait": {
      const dispatched_at = now();
      await sleep(step.ms ?? 500);
      return { dispatched_at, input_effect_at: now(), selector: null };
    }
    default:
      throw new Error(`Unsupported step type: ${step.type}`);
  }
}

/**
 * Run a recorded take.
 *
 * params: { url?, viewport: {width,height}, steps: [...], outDir,
 *   headless?, channel?, markers?: { holdMs, settleMs, color },
 *   stepTimeoutMs? }
 * Returns { videoPath, log }.
 */
export async function runTake(params) {
  const viewport = params.viewport || { width: 1280, height: 720 };
  const outDir = params.outDir;
  if (!outDir) throw new Error("outDir is required");
  fs.mkdirSync(outDir, { recursive: true });
  const markerOpts = { holdMs: 160, gapMs: 240, settleMs: 400, color: MARKER_COLOR, stripHeight: 0, ...(params.markers || {}) };
  // Strip markers live in extra rows below the scripted viewport (the page
  // lays out 16px taller, the strip covers those rows) so the renderer can
  // crop them off and keep every frame of the page visible.
  const recordViewport = { width: viewport.width, height: viewport.height + (markerOpts.stripHeight || 0) };
  const stepTimeoutMs = params.stepTimeoutMs ?? 15000;

  const browser = await chromium.launch({
    headless: params.headless ?? true,
    ...(params.channel ? { channel: params.channel } : {}),
  });
  const log = {
    viewport,
    recordViewport,
    markerStripHeight: markerOpts.stripHeight || 0,
    headless: params.headless ?? true,
    channel: params.channel || "chromium",
    playwright: (await import("playwright/package.json", { with: { type: "json" } })).default.version,
    browserVersion: browser.version(),
    markers: [],
    steps: [],
  };
  let videoPath = null;
  try {
    const context_requested_at = now();
    const context = await browser.newContext({
      viewport: recordViewport,
      deviceScaleFactor: 1,
      recordVideo: { dir: outDir, size: recordViewport },
    });
    const context_created_at = now();
    const witnessEvents = [];
    const witnessOn = params.witness !== false;
    if (witnessOn) {
      await context.exposeBinding(WITNESS_BINDING, (_source, ev) => {
        witnessEvents.push({ ...ev, received_at: now() });
      });
      await context.addInitScript(witnessInit, {
        binding: WITNESS_BINDING,
        markerId: MARKER_ID,
        effectWindowMs: WITNESS_EFFECT_WINDOW_MS,
      });
    }
    const page = await context.newPage();
    const page_created_at = now();
    const net = trackRequests(page);
    const t0 = page_created_at;
    log.epoch = {
      clock: "process.hrtime.bigint",
      page_created_at_ns: page_created_at.toString(),
      context_requested_ms: relMs(t0, context_requested_at),
      context_created_ms: relMs(t0, context_created_at),
    };

    log.markers.push(await flashMarker(page, t0, "start", markerOpts));
    const steps = [
      ...(params.url ? [{ type: "navigate", url: params.url, expect: params.expect, label: "navigate" }] : []),
      ...(params.steps || []),
    ];

    for (const [index, step] of steps.entries()) {
      const entry = { index, type: step.type, label: step.label || `${step.type}-${index}`, status: "ok" };
      try {
        const prepared = await prepare(page, step, stepTimeoutMs);
        // Pages that keep loading after an action (hover preloads in Docusaurus
        // or Next.js, lazy chunks after a route change) can stall the screencast
        // for most of a second; a stall over a marker hides the action. Let the
        // network go quiet before the pre-marker.
        entry.pre_quiet_ms = await net.quiet(step.preQuietMs ?? 300, step.preQuietMaxMs ?? 3000);
        const clockPre = witnessOn ? await clockProbe(page, t0) : null;
        log.markers.push(await flashMarker(page, t0, `pre:${entry.label}`, markerOpts));
        await sleep(markerOpts.settleMs);
        const firstEvent = witnessEvents.length;
        const d = await dispatch(page, step, prepared, stepTimeoutMs);
        entry.selector = d.selector;
        if (d.selector_attempts) entry.selector_attempts = d.selector_attempts;
        if (d.target_box) entry.target_box = d.target_box;
        entry.dispatched_ms = relMs(t0, d.dispatched_at);
        entry.input_effect_ms = relMs(t0, d.input_effect_at);
        entry.postcondition = await waitPostcondition(page, step.expect, stepTimeoutMs);
        entry.postcondition_ms = relMs(t0, now());
        const clockPost = witnessOn ? await clockProbe(page, t0) : null;
        const observe = step.observe || step.expect?.selector;
        const observe_box = await boxOf(page, observe);
        if (observe_box) entry.observe_box = observe_box;
        await sleep(markerOpts.settleMs);
        log.markers.push(await flashMarker(page, t0, `post:${entry.label}`, markerOpts));
        if (witnessOn) {
          // Binding calls arrive asynchronously; by the end of the post
          // marker every event before it has been delivered. Keep effects
          // up to the post marker: a route change satisfies its URL
          // postcondition before the new page renders.
          const postMarker = log.markers[log.markers.length - 1];
          const untilPage = postMarker.on_requested_ms - clockPost.offset_ms;
          entry.witness = {
            clock_pre: clockPre,
            clock_post: clockPost,
            events: witnessEvents
              .slice(firstEvent)
              .filter((ev) => ev.at <= untilPage)
              .map(({ received_at, ...ev }) => ({ ...ev, received_ms: relMs(t0, received_at) })),
          };
        }
      } catch (e) {
        entry.status = "failed";
        entry.error = e.message.split("\n")[0];
      }
      log.steps.push(entry);
      if (entry.status === "failed" && !params.continueOnError) break;
    }
    log.markers.push(await flashMarker(page, t0, "end", markerOpts));
    net.stop();

    const video = page.video();
    const close_requested_at = now();
    await context.close();
    log.epoch.context_closed_ms = relMs(t0, now());
    log.epoch.close_requested_ms = relMs(t0, close_requested_at);
    videoPath = video ? await video.path() : null;
  } finally {
    await browser.close();
  }
  const logPath = path.join(outDir, "take-log.json");
  fs.writeFileSync(logPath, JSON.stringify({ videoPath, ...log }, null, 2));
  return { videoPath, logPath, log };
}

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

const now = () => process.hrtime.bigint();
const relMs = (t0, t) => Number(t - t0) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setMarker(page, visible, color) {
  return page.evaluate(
    async ({ visible, color }) => {
      const id = "__cutready_calibration_marker";
      let el = document.getElementById(id);
      if (visible) {
        if (!el) {
          el = document.createElement("div");
          el.id = id;
          el.style.cssText = `position:fixed;inset:0;z-index:2147483647;pointer-events:none;background:${color}`;
          document.documentElement.appendChild(el);
        }
      } else if (el) {
        el.remove();
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return performance.now();
    },
    { visible, color },
  );
}

/** Flash the calibration overlay for ~holdMs and log host stamps. */
async function flashMarker(page, t0, label, { holdMs, gapMs, color }) {
  const on_requested_at = now();
  await setMarker(page, true, color);
  const on_ack_at = now();
  await sleep(holdMs);
  const off_requested_at = now();
  await setMarker(page, false, color);
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

async function dispatch(page, step, timeoutMs) {
  switch (step.type) {
    case "navigate": {
      const dispatched_at = now();
      await page.goto(step.url, { waitUntil: step.waitUntil || "load", timeout: timeoutMs });
      return { dispatched_at, input_effect_at: now(), selector: null };
    }
    case "click": {
      const { locator, selector, tried } = await resolveSelector(page, step.selectors, step.selectorTimeoutMs ?? 3000);
      const dispatched_at = now();
      await locator.click({ timeout: timeoutMs });
      return { dispatched_at, input_effect_at: now(), selector, selector_attempts: tried };
    }
    case "type": {
      const { locator, selector, tried } = await resolveSelector(page, step.selectors, step.selectorTimeoutMs ?? 3000);
      const dispatched_at = now();
      await locator.pressSequentially(step.text, { delay: step.delayMs ?? 40, timeout: timeoutMs });
      return { dispatched_at, input_effect_at: now(), selector, selector_attempts: tried };
    }
    case "scroll": {
      const dispatched_at = now();
      await page.mouse.wheel(step.dx ?? 0, step.dy ?? 600);
      return { dispatched_at, input_effect_at: now(), selector: null };
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
  const markerOpts = { holdMs: 160, gapMs: 240, settleMs: 400, color: MARKER_COLOR, ...(params.markers || {}) };
  const stepTimeoutMs = params.stepTimeoutMs ?? 15000;

  const browser = await chromium.launch({
    headless: params.headless ?? true,
    ...(params.channel ? { channel: params.channel } : {}),
  });
  const log = {
    viewport,
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
      viewport,
      deviceScaleFactor: 1,
      recordVideo: { dir: outDir, size: viewport },
    });
    const context_created_at = now();
    const page = await context.newPage();
    const page_created_at = now();
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
        log.markers.push(await flashMarker(page, t0, `pre:${entry.label}`, markerOpts));
        await sleep(markerOpts.settleMs);
        const d = await dispatch(page, step, stepTimeoutMs);
        entry.selector = d.selector;
        if (d.selector_attempts) entry.selector_attempts = d.selector_attempts;
        entry.dispatched_ms = relMs(t0, d.dispatched_at);
        entry.input_effect_ms = relMs(t0, d.input_effect_at);
        entry.postcondition = await waitPostcondition(page, step.expect, stepTimeoutMs);
        entry.postcondition_ms = relMs(t0, now());
        await sleep(markerOpts.settleMs);
        log.markers.push(await flashMarker(page, t0, `post:${entry.label}`, markerOpts));
      } catch (e) {
        entry.status = "failed";
        entry.error = e.message.split("\n")[0];
      }
      log.steps.push(entry);
      if (entry.status === "failed" && !params.continueOnError) break;
    }
    log.markers.push(await flashMarker(page, t0, "end", markerOpts));

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

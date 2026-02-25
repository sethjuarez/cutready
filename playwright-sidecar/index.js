/**
 * CutReady Playwright Sidecar
 *
 * Node.js process that manages a browser for demo recording.
 * Two-phase workflow: prepare browser → start/stop observing (multiple takes).
 *
 * Communicates with the Rust backend via newline-delimited JSON over stdin/stdout.
 *
 * Protocol:
 *   Request:  { "id": number, "method": string, "params": object }
 *   Response: { "id": number, "result": object } | { "id": number, "error": { "message": string } }
 *   Event:    { "event": string, "data": object }
 *
 * Methods: ping, browser.prepare, browser.startObserving, browser.stopObserving,
 *          browser.close, browser.screenshot
 * Events:  action_captured, browser_disconnected
 */

import { chromium } from "playwright";
import * as readline from "readline";
import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";

let browser = null;
let context = null;
let page = null;
let screenshotsDir = null;
let actionCounter = 0;
let isObserving = false;
let browserChannel = null;
let bridgeInstalled = false;
let isPersistentContext = false;

// ── Protocol Communication ──────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResponse(id, result) {
  send({ id, result });
}

function sendError(id, error) {
  send({ id, error: { message: String(error) } });
}

function sendEvent(event, data) {
  send({ event, data });
}

// ── Request Dispatcher ──────────────────────────────────────────────────────

rl.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line.trim());
  } catch {
    return; // Skip malformed lines
  }

  const { id, method, params } = request;

  try {
    switch (method) {
      case "ping":
        sendResponse(id, { status: "pong" });
        break;
      case "browser.prepare":
        await handleBrowserPrepare(id, params || {});
        break;
      case "browser.startObserving":
        await handleStartObserving(id, params || {});
        break;
      case "browser.stopObserving":
        await handleStopObserving(id);
        break;
      case "browser.close":
        await handleBrowserClose(id);
        break;
      case "browser.screenshot":
        await handleScreenshot(id, params || {});
        break;
      default:
        sendError(id, `Unknown method: ${method}`);
    }
  } catch (e) {
    sendError(id, e.message || String(e));
  }
});

// ── Handlers ────────────────────────────────────────────────────────────────

/**
 * Prepare a browser for recording.
 *
 * Two modes:
 *   1. **Profile mode** — When `user_data_dir` and `profile_directory` are
 *      provided, launches with the user's real browser profile using
 *      `launchPersistentContext`. Extensions, passwords, and bookmarks
 *      are available. The browser must NOT already be running.
 *   2. **Fresh mode** — Tries Edge → Chrome → bundled Chromium. Clean
 *      browser with no extensions. The user's existing browser stays open.
 *
 * Does NOT inject any observers yet — the user preps their demo first,
 * then calls browser.startObserving.
 */
async function handleBrowserPrepare(id, params) {
  if (browser || context) {
    sendError(id, "Browser already prepared");
    return;
  }

  const userDataDir = params.user_data_dir;
  const profileDir = params.profile_directory;
  const requestedChannel = params.browser_channel;

  if (userDataDir && profileDir) {
    // ── Profile mode: launch with real user profile ──────────

    const channel = requestedChannel || "msedge";

    // Kill background browser processes that lock the profile directory.
    // The Rust layer already verified no visible windows are open — these
    // are just service workers, updaters, and extension hosts.
    const processName =
      channel === "msedge" ? "msedge.exe" : "chrome.exe";
    try {
      execSync(`taskkill /F /IM ${processName} /T`, {
        windowsHide: true,
        stdio: "ignore",
      });
      // Brief pause to let the OS release file locks
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } catch {
      // No processes to kill — that's fine
    }

    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        channel,
        headless: false,
        args: [`--profile-directory=${profileDir}`, "--start-maximized"],
        ignoreDefaultArgs: ["--disable-extensions"],
        viewport: null,
      });
      browserChannel = channel;
      isPersistentContext = true;
    } catch (e) {
      sendError(
        id,
        `Failed to launch ${channel} with profile "${profileDir}": ${e.message}`,
      );
      return;
    }

    page = context.pages()[0] || (await context.newPage());
    browser = null; // No separate browser ref for persistent contexts

    // Show CutReady welcome page
    try {
      await page.goto(getCutReadyWelcomePage());
    } catch {
      // Ignore — page may have navigated already
    }

    // Detect user closing the browser
    context.on("close", () => {
      browser = null;
      context = null;
      page = null;
      isObserving = false;
      bridgeInstalled = false;
      isPersistentContext = false;
      sendEvent("browser_disconnected", {});
    });
  } else {
    // ── Fresh mode: try installed browsers in order ──────────

    const channels = ["msedge", "chrome", ""];
    let lastError;

    for (const channel of channels) {
      try {
        const launchOpts = {
          headless: false,
          args: ["--start-maximized"],
        };
        if (channel) {
          launchOpts.channel = channel;
        }
        browser = await chromium.launch(launchOpts);
        browserChannel = channel || "chromium";
        break;
      } catch (e) {
        lastError = e;
        continue;
      }
    }

    if (!browser) {
      sendError(id, `No browser found: ${lastError?.message}`);
      return;
    }

    context = await browser.newContext({ viewport: null });
    page = await context.newPage();
    isPersistentContext = false;

    // Show CutReady welcome page
    try {
      await page.goto(getCutReadyWelcomePage());
    } catch {
      // Ignore — page may have navigated already
    }

    // Handle browser disconnect (user closed the browser window)
    browser.on("disconnected", () => {
      browser = null;
      context = null;
      page = null;
      isObserving = false;
      bridgeInstalled = false;
      isPersistentContext = false;
      sendEvent("browser_disconnected", {});
    });
  }

  // Track navigations (only forwarded when observing)
  page.on("framenavigated", (frame) => {
    if (!isObserving) return;
    if (frame !== page?.mainFrame()) return;

    const currentUrl = frame.url();
    if (currentUrl && currentUrl !== "about:blank") {
      sendEvent("action_captured", {
        action: {
          type: "BrowserNavigate",
          url: currentUrl,
        },
        metadata: {
          captured_screenshot: null,
          selector_strategies: [],
          timestamp_ms: Date.now(),
          confidence: 1.0,
          context_snapshot: null,
        },
        raw_event: {
          source: "cdp",
          data: JSON.stringify({ type: "framenavigated", url: currentUrl }),
        },
      });
    }
  });

  sendResponse(id, {
    status: "ok",
    browser_channel: browserChannel,
  });
}

/**
 * Start observing the active page.
 *
 * Injects the DOM observer into the current page and sets up addInitScript
 * for future navigations. The bridge function gates events — only forwarded
 * while isObserving is true, so multiple start/stop cycles work.
 */
async function handleStartObserving(id, params) {
  if (!page || (!browser && !context)) {
    sendError(id, "No browser prepared");
    return;
  }

  screenshotsDir = params.screenshots_dir || null;
  actionCounter = 0;
  isObserving = true;

  if (screenshotsDir) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  // Install the bridge function once per page lifetime.
  // exposeFunction persists across navigations.
  if (!bridgeInstalled) {
    await page.exposeFunction(
      "__cutready_report_action",
      async (actionJson) => {
        // Gate: only forward events when actively observing
        if (!isObserving) return;

        try {
          const actionData = JSON.parse(actionJson);

          // Take a screenshot at the moment of the action
          let screenshotPath = null;
          if (screenshotsDir && page) {
            const filename = `action_${String(actionCounter).padStart(4, "0")}_${Date.now()}.png`;
            screenshotPath = path.join(screenshotsDir, filename);
            try {
              await page.screenshot({ path: screenshotPath });
            } catch {
              screenshotPath = null;
            }
            actionCounter++;
          }

          actionData.metadata.captured_screenshot = screenshotPath;
          sendEvent("action_captured", actionData);
        } catch {
          // Don't crash the sidecar on malformed action data
        }
      },
    );

    // Register init script for future navigations
    await page.addInitScript({ content: getDomObserverScript() });

    bridgeInstalled = true;
  }

  // Inject observer into the current page immediately.
  // The script is idempotent (checks __cutready_observer_installed).
  try {
    await page.evaluate(getDomObserverScript());
  } catch {
    // May fail on special pages (chrome://, etc.) — that's OK
  }

  sendResponse(id, { status: "ok" });
}

/**
 * Stop observing. Events from the DOM observer are silently dropped.
 * The browser stays open — user can prep for another take.
 */
async function handleStopObserving(id) {
  isObserving = false;
  screenshotsDir = null;
  sendResponse(id, { status: "ok" });
}

async function handleBrowserClose(id) {
  if (!browser && !context) {
    sendError(id, "No browser to close");
    return;
  }

  try {
    if (isPersistentContext && context) {
      await context.close();
    } else if (browser) {
      await browser.close();
    }
  } catch {
    // Browser may already be closed
  }

  browser = null;
  context = null;
  page = null;
  isObserving = false;
  bridgeInstalled = false;
  isPersistentContext = false;

  sendResponse(id, { status: "ok" });
}

async function handleScreenshot(id, params) {
  if (!page) {
    sendError(id, "No page available");
    return;
  }

  const outputPath = params.output_path;
  if (!outputPath) {
    sendError(id, "output_path is required");
    return;
  }

  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });

  await page.screenshot({
    path: outputPath,
    fullPage: params.full_page || false,
  });

  sendResponse(id, { status: "ok", path: outputPath });
}

// ── CutReady Welcome Page ───────────────────────────────────────────────────

function getCutReadyWelcomePage() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>CutReady</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, 'Segoe UI', system-ui, sans-serif;
      background: #1c1a17;
      color: #e8e4de;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      text-align: center;
    }
    .container { max-width: 480px; padding: 2rem; }
    .logo {
      width: 64px; height: 64px;
      margin: 0 auto 1.5rem;
      background: rgba(164, 154, 250, 0.12);
      border-radius: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .logo svg { width: 32px; height: 32px; }
    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      letter-spacing: -0.02em;
      margin-bottom: 0.5rem;
    }
    .accent { color: #a49afa; }
    p {
      font-size: 0.9rem;
      color: #a09b93;
      line-height: 1.6;
    }
    .steps {
      margin-top: 2rem;
      text-align: left;
    }
    .step {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 0.6rem 0;
    }
    .step-num {
      flex-shrink: 0;
      width: 24px; height: 24px;
      border-radius: 50%;
      background: rgba(164, 154, 250, 0.15);
      color: #a49afa;
      font-size: 0.75rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .step-text {
      font-size: 0.85rem;
      color: #c8c3bb;
      line-height: 1.5;
    }
    .kbd {
      display: inline-block;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 4px;
      padding: 0.1em 0.4em;
      font-family: monospace;
      font-size: 0.8em;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none" width="48" height="48">
        <rect width="128" height="128" rx="24" fill="#3d3480"/>
        <rect x="14" y="52" width="100" height="64" rx="4" fill="#7c6fdb"/>
        <rect x="14" y="26" width="100" height="16" rx="3" fill="#a49afa" transform="rotate(-14 14 42)"/>
        <circle cx="14" cy="48" r="5" fill="white"/>
        <path d="M48 68 L88 84 L48 100Z" fill="white"/>
      </svg>
    </div>
    <h1>Controlled by <span class="accent">CutReady</span></h1>
    <p>This browser is connected to CutReady for demo recording.</p>
    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-text">Navigate to your demo starting point</div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-text">Click <strong>Ready to Record</strong> in CutReady — or press <span class="kbd">Ctrl+Shift+R</span></div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-text">Walk through your demo naturally</div>
      </div>
    </div>
  </div>
</body>
</html>`;
  return "data:text/html;base64," + Buffer.from(html).toString("base64");
}

// ── DOM Observer Script ─────────────────────────────────────────────────────
//
// Injected into every page via addInitScript. Captures user interactions
// (clicks, typing, select changes, scrolls) and reports them via the
// __cutready_report_action bridge function.

function getDomObserverScript() {
  return `
    (() => {
      // Prevent double-injection on same page
      if (window.__cutready_observer_installed) return;
      window.__cutready_observer_installed = true;

      // ── Selector Builders ───────────────────────────────────

      function buildSelectors(el) {
        const selectors = [];

        // data-testid (highest priority for test frameworks)
        const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
        if (testId) {
          selectors.push({ strategy: 'DataTestId', value: testId });
        }

        // ID-based CSS selector
        if (el.id) {
          selectors.push({ strategy: 'CssSelector', value: '#' + CSS.escape(el.id) });
        }

        // aria-label for accessibility
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) {
          selectors.push({ strategy: 'AccessibilityName', value: ariaLabel });
        }

        // Text content for buttons and links
        const tag = el.tagName.toLowerCase();
        if (['button', 'a', 'label'].includes(tag)) {
          const text = (el.textContent || '').trim();
          if (text && text.length > 0 && text.length < 100) {
            selectors.push({ strategy: 'TextContent', value: text });
          }
        }

        // CSS path fallback (always included)
        selectors.push({ strategy: 'CssSelector', value: buildCssPath(el) });

        return selectors;
      }

      function buildCssPath(el) {
        const parts = [];
        let current = el;
        while (current && current !== document.documentElement) {
          let selector = current.tagName.toLowerCase();
          if (current.id) {
            parts.unshift('#' + CSS.escape(current.id));
            break;
          }
          const parent = current.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter(
              (c) => c.tagName === current.tagName
            );
            if (siblings.length > 1) {
              const index = siblings.indexOf(current) + 1;
              selector += ':nth-of-type(' + index + ')';
            }
          }
          parts.unshift(selector);
          current = parent;
        }
        return parts.join(' > ');
      }

      function getElementContext(el) {
        return (el.outerHTML || '').substring(0, 500);
      }

      function reportAction(actionData) {
        if (typeof window.__cutready_report_action === 'function') {
          window.__cutready_report_action(JSON.stringify(actionData)).catch(() => {});
        }
      }

      // ── Click Capture ───────────────────────────────────────

      document.addEventListener('click', (e) => {
        const target = e.target;
        if (!target || !target.tagName) return;

        const selectors = buildSelectors(target);
        reportAction({
          action: {
            type: 'BrowserClick',
            selectors: selectors,
          },
          metadata: {
            captured_screenshot: null,
            selector_strategies: selectors,
            timestamp_ms: Date.now(),
            confidence: 0.85,
            context_snapshot: getElementContext(target),
          },
          raw_event: {
            source: 'dom_observer',
            data: JSON.stringify({
              type: 'click',
              x: e.clientX,
              y: e.clientY,
              tagName: target.tagName,
              id: target.id || null,
              className: target.className || null,
            }),
          },
        });
      }, true);

      // ── Input / Type Capture (debounced) ────────────────────

      let inputTimer = null;
      let currentInputTarget = null;
      let currentInputValue = '';

      function flushInput() {
        if (currentInputTarget && currentInputValue) {
          const target = currentInputTarget;
          const selectors = buildSelectors(target);
          reportAction({
            action: {
              type: 'BrowserType',
              selectors: selectors,
              text: currentInputValue,
              clear_first: false,
            },
            metadata: {
              captured_screenshot: null,
              selector_strategies: selectors,
              timestamp_ms: Date.now(),
              confidence: 0.8,
              context_snapshot: getElementContext(target),
            },
            raw_event: {
              source: 'dom_observer',
              data: JSON.stringify({
                type: 'input',
                tagName: target.tagName,
                inputType: target.type || 'text',
                value: currentInputValue,
              }),
            },
          });
        }
        currentInputTarget = null;
        currentInputValue = '';
      }

      document.addEventListener('input', (e) => {
        const target = e.target;
        if (!target) return;
        const tag = target.tagName;
        if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;

        // SELECT changes are reported immediately
        if (tag === 'SELECT') {
          const selectors = buildSelectors(target);
          reportAction({
            action: {
              type: 'BrowserSelect',
              selectors: selectors,
              value: target.value,
            },
            metadata: {
              captured_screenshot: null,
              selector_strategies: selectors,
              timestamp_ms: Date.now(),
              confidence: 0.9,
              context_snapshot: getElementContext(target),
            },
            raw_event: {
              source: 'dom_observer',
              data: JSON.stringify({ type: 'select', value: target.value }),
            },
          });
          return;
        }

        // Text inputs: debounce to batch keystrokes
        if (currentInputTarget !== target) {
          flushInput(); // Flush previous input if the target changed
          currentInputTarget = target;
        }

        currentInputValue = target.value || '';
        clearTimeout(inputTimer);
        inputTimer = setTimeout(flushInput, 800);
      }, true);

      // Flush on blur (user leaves the input field)
      document.addEventListener('focusout', (e) => {
        if (e.target === currentInputTarget) {
          clearTimeout(inputTimer);
          flushInput();
        }
      }, true);

      // ── Scroll Capture (debounced) ──────────────────────────

      let scrollTimer = null;
      let scrollStartY = window.scrollY;

      window.addEventListener('scroll', () => {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
          const delta = window.scrollY - scrollStartY;
          if (Math.abs(delta) > 50) { // Only report significant scrolls
            reportAction({
              action: {
                type: 'BrowserScroll',
                direction: delta > 0 ? 'down' : 'up',
                amount: Math.abs(Math.round(delta)),
              },
              metadata: {
                captured_screenshot: null,
                selector_strategies: [],
                timestamp_ms: Date.now(),
                confidence: 0.7,
                context_snapshot: null,
              },
              raw_event: {
                source: 'dom_observer',
                data: JSON.stringify({
                  type: 'scroll',
                  deltaY: delta,
                  scrollY: window.scrollY,
                }),
              },
            });
          }
          scrollStartY = window.scrollY;
        }, 500);
      }, { passive: true });
    })();
  `;
}

// ── Graceful Shutdown ───────────────────────────────────────────────────────

async function cleanup() {
  if (isPersistentContext && context) {
    try {
      await context.close();
    } catch {
      // Ignore — context may already be gone
    }
  } else if (browser) {
    try {
      await browser.close();
    } catch {
      // Ignore — browser may already be gone
    }
  }
  process.exit(0);
}

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
process.stdin.on("end", cleanup);


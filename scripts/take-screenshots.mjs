/**
 * Screenshot script for CutReady docs.
 * Navigates the Vite dev app (devMock active at http://localhost:1420).
 * Run: node scripts/take-screenshots.mjs
 *
 * Navigation map:
 *  - Home screen loads at startup
 *  - Click "mock-project" → opens project (view = "project")
 *  - button[title="Sketches"] → sketches sidebar
 *  - button[title="Storyboards"] → storyboards sidebar
 *  - button[title="Notes"] → notes sidebar
 *  - button[title="Explorer"] → file tree
 *  - button[title="Workspace"] → workspace settings
 *  - button[title="Settings"] → global settings
 *  - Ctrl+Shift+B → toggle secondary panel (ChatPanel)
 *  - In secondary panel: click MoreVertical → "Snapshots" → VersionHistory
 *  - In VersionHistory: Clock button → opens History tab in main editor
 *  - Ctrl+` → toggle output panel
 */

import { chromium } from "playwright";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = "http://localhost:1420";
const OUT_DIR = path.resolve(__dirname, "../docs/public/images");

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORT = { width: 1280, height: 800 };

/** Take a screenshot and save it. */
async function shot(page, name) {
  await page.waitForTimeout(300);
  const file = path.join(OUT_DIR, name);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  ✓ ${name}`);
}

/** Set theme to light or dark. */
async function setTheme(page, dark) {
  await page.evaluate((isDark) => {
    if (isDark) {
      document.documentElement.classList.add("dark");
      localStorage.setItem("cutready-theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("cutready-theme", "light");
    }
  }, dark);
  await page.waitForTimeout(200);
}

/** Click a sidebar nav button by title. */
async function clickSidebarBtn(page, title) {
  await page.click(`button[title="${title}"]`);
  await page.waitForTimeout(400);
}

/** Click the first element matching the text. */
async function clickText(page, text) {
  await page.locator(`text="${text}"`).first().click();
  await page.waitForTimeout(500);
}

/** Take screenshots for all doc pages in the current theme. */
async function captureAll(page, suffix) {
  // ── HOME ──────────────────────────────────────────────────────────────────
  await shot(page, `app-home${suffix}.png`);

  // ── OPEN PROJECT ──────────────────────────────────────────────────────────
  // The devMock returns recent project "mock-project" at path C:/mock-project
  await page.locator("text=mock-project").first().click();
  await page.waitForTimeout(800);

  // App-overview: project loaded, empty editor (no tab open yet)
  await shot(page, `app-overview${suffix}.png`);

  // ── SKETCHES SIDEBAR ──────────────────────────────────────────────────────
  await clickSidebarBtn(page, "Sketches");
  await shot(page, `sketch-sidebar${suffix}.png`);

  // ── OPEN SKETCH ───────────────────────────────────────────────────────────
  await clickText(page, "Demo Introduction");
  await shot(page, `sketch-editor${suffix}.png`);
  await shot(page, `sketch-editor-full${suffix}.png`);
  await shot(page, `sketch-form${suffix}.png`);

  // ── SKETCH WITH SECONDARY (CHAT) PANEL ───────────────────────────────────
  await page.keyboard.press("Control+Shift+B");
  await page.waitForTimeout(600);
  await shot(page, `sketch-with-chat${suffix}.png`);

  // ── SECONDARY PANEL: SNAPSHOTS ────────────────────────────────────────────
  // Click "More options" (MoreVertical) in the Chat panel header
  await page.click('button[title="More options"]');
  await page.waitForTimeout(300);
  // Click "Snapshots" in the dropdown
  await page.locator("text=Snapshots").last().click();
  await page.waitForTimeout(500);
  await shot(page, `snapshots-panel${suffix}.png`);

  // ── SNAPSHOTS WITH TIMELINE SELECTOR ─────────────────────────────────────
  // TimelineSelector only shows when timelines.length > 1
  // devMock only returns 1 timeline — use existing or reuse snapshots-panel
  await shot(page, `snapshots-with-timelines${suffix}.png`);
  await shot(page, `timeline-selector${suffix}.png`);

  // ── HISTORY GRAPH (opens a tab in main editor) ────────────────────────────
  await page.click('button[title="Open full history graph"]');
  await page.waitForTimeout(800);
  await shot(page, `history-graph${suffix}.png`);

  // Close secondary panel
  await page.keyboard.press("Control+Shift+B");
  await page.waitForTimeout(400);

  // ── STORYBOARDS ───────────────────────────────────────────────────────────
  await clickSidebarBtn(page, "Storyboards");
  await clickText(page, "Full Demo Flow");
  await shot(page, `storyboard-view${suffix}.png`);
  await shot(page, `storyboard-full${suffix}.png`);

  // ── NOTES ─────────────────────────────────────────────────────────────────
  await clickSidebarBtn(page, "Notes");
  await clickText(page, "Script Draft");
  await shot(page, `note-editor${suffix}.png`);
  await shot(page, `notes-editor-full${suffix}.png`);

  // ── FILE TREE (EXPLORER) ──────────────────────────────────────────────────
  await clickSidebarBtn(page, "Explorer");
  await shot(page, `file-tree-view${suffix}.png`);

  // ── OUTPUT PANEL (ACTIVITY + TERMINAL) ────────────────────────────────────
  await page.keyboard.press("Control+`");
  await page.waitForTimeout(500);
  await shot(page, `debug-panel${suffix}.png`);

  // Close output panel
  await page.keyboard.press("Control+`");
  await page.waitForTimeout(300);

  // ── MERGE CONFLICT PANEL (inject state via exposed appStore) ────────────────
  await clickSidebarBtn(page, "Project");
  await page.evaluate(() => {
    if (window.__appStore) window.__appStore.setState({ isMerging: true });
  });
  await page.waitForTimeout(500);
  await shot(page, `merge-conflict-panel${suffix}.png`);
  await page.evaluate(() => {
    if (window.__appStore) window.__appStore.setState({ isMerging: false });
  });
  await page.waitForTimeout(300);

  // ── GLOBAL SETTINGS ───────────────────────────────────────────────────────
  await clickSidebarBtn(page, "Settings");
  await page.waitForTimeout(500);
  await shot(page, `settings-panel${suffix}.png`);

  // AI Provider tab
  await page.locator('button:has-text("AI Provider")').first().click();
  await page.waitForTimeout(300);
  await shot(page, `settings-ai-provider${suffix}.png`);

  // Agents tab
  await page.locator('button:has-text("Agents")').first().click();
  await page.waitForTimeout(300);
  await shot(page, `settings-agents${suffix}.png`);

  // Feedback tab
  await page.locator('button:has-text("Feedback")').first().click();
  await page.waitForTimeout(300);
  await shot(page, `settings-feedback${suffix}.png`);

  // Updates tab
  await page.locator('button:has-text("Updates")').first().click();
  await page.waitForTimeout(300);
  await shot(page, `settings-display${suffix}.png`); // reuse name

  // Back to Display
  await page.locator('button:has-text("Display")').first().click();
  await page.waitForTimeout(300);

  // ── WORKSPACE SETTINGS ────────────────────────────────────────────────────
  await clickSidebarBtn(page, "Workspace");
  await page.waitForTimeout(500);
  await shot(page, `settings-images${suffix}.png`);

  // ── CONTEXT MENU (right-click on sidebar item) ────────────────────────────
  // Navigate back to sketches sidebar first
  await clickSidebarBtn(page, "Sketches");
  await page.waitForTimeout(300);
  const sketchItem = page.locator("text=Demo Introduction").first();
  await sketchItem.click({ button: "right" });
  await page.waitForTimeout(400);
  await shot(page, `context-menu${suffix}.png`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  for (const dark of [false, true]) {
    const suffix = dark ? "-dark" : "";
    console.log(`\n📸 ${dark ? "DARK" : "LIGHT"} mode screenshots`);

    const context = await browser.newContext({
      viewport: VIEWPORT,
      colorScheme: dark ? "dark" : "light",
    });
    const page = await context.newPage();

    // Suppress expected console noise
    page.on("pageerror", (e) => {
      if (!e.message.includes("ResizeObserver")) {
        console.warn("  ⚠ page error:", e.message.slice(0, 80));
      }
    });

    await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForTimeout(1000);
    await setTheme(page, dark);

    try {
      await captureAll(page, suffix);
    } catch (err) {
      console.error(`  ✗ Error in ${dark ? "dark" : "light"} mode:`, err.message);
      // Take a diagnostic screenshot
      await page.screenshot({ path: path.join(OUT_DIR, `_error${suffix}.png`) });
    }

    await context.close();
  }

  await browser.close();
  console.log(`\n✅ Done — images in ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

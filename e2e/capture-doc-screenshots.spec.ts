/**
 * Screenshot capture script for CutReady documentation.
 * Captures every unique screenshot at 1920×1080 in both light and dark mode.
 * 
 * Usage: npx playwright test e2e/capture-doc-screenshots.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";

const IMG_DIR = "docs/public/images/";

// ── Helpers ──────────────────────────────────────────────

async function setupApp(page: Page, opts?: { panels?: boolean }) {
  await page.goto("/");
  await page.waitForSelector("#root", { timeout: 10_000 });
  // Click mock-project to enter the workspace
  await page.getByText("mock-project", { exact: true }).click();
  await page.waitForTimeout(600);
}

async function setupAppWithPanels(page: Page) {
  await page.goto("/");
  await page.waitForSelector("#root", { timeout: 10_000 });
  await page.getByText("mock-project", { exact: true }).click();
  await page.waitForTimeout(600);
  // Show secondary panel (hidden by default in fresh session)
  await page.getByRole("button", { name: "Toggle Secondary Panel" }).click();
  await page.waitForTimeout(300);
}

/** Navigate to home screen (before project selection) */
async function goHome(page: Page) {
  await page.goto("/");
  await page.waitForSelector("#root", { timeout: 10_000 });
}

async function setOverrides(page: Page, overrides: Record<string, unknown>) {
  await page.evaluate((ov) => {
    const w = window as any;
    if (!w.__MOCK_OVERRIDES__) w.__MOCK_OVERRIDES__ = {};
    Object.assign(w.__MOCK_OVERRIDES__, ov);
  }, overrides);
}

async function ensureLight(page: Page) {
  const isDark = await page.evaluate(() =>
    document.documentElement.classList.contains("dark")
  );
  if (isDark) {
    await page.evaluate(() => {
      localStorage.setItem("cutready-theme", "light");
      document.documentElement.classList.remove("dark");
    });
    await page.waitForTimeout(200);
  }
}

async function ensureDark(page: Page) {
  const isDark = await page.evaluate(() =>
    document.documentElement.classList.contains("dark")
  );
  if (!isDark) {
    await page.evaluate(() => {
      localStorage.setItem("cutready-theme", "dark");
      document.documentElement.classList.add("dark");
    });
    await page.waitForTimeout(200);
  }
}

/** Capture light + dark screenshots with the given base name */
async function snap(page: Page, name: string) {
  await ensureLight(page);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${IMG_DIR}${name}.png` });

  await ensureDark(page);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${IMG_DIR}${name}-dark.png` });

  // Return to light for next operation
  await ensureLight(page);
}

/** Open a sketch by name from the sidebar */
async function openSketch(page: Page, name: string) {
  await page.getByText(name).first().click();
  await page.waitForTimeout(500);
}

/** Toggle the secondary (right) panel open if it's not visible */
async function ensureSecondaryPanel(page: Page) {
  const chatBtn = page.getByRole("button", { name: "Chat" });
  if (!(await chatBtn.isVisible({ timeout: 1000 }).catch(() => false))) {
    await page.getByRole("button", { name: "Toggle Secondary Panel" }).click();
    await page.waitForTimeout(500);
  }
}

/** Ensure the bottom panel (Activity/Debug) is visible */
async function ensureBottomPanel(page: Page) {
  const activityBtn = page.getByRole("button", { name: "Activity" });
  if (!(await activityBtn.isVisible({ timeout: 1000 }).catch(() => false))) {
    await page.getByRole("button", { name: /Toggle Panel/ }).click();
    await page.waitForTimeout(500);
  }
}

/** Switch the secondary panel to a given tab */
async function switchSecondaryTab(page: Page, tab: "Chat" | "Sessions" | "Snapshots") {
  await page.getByRole("button", { name: tab }).first().click();
  await page.waitForTimeout(300);
}

// ── Multi-timeline mock data ─────────────────────────────

const MULTI_TIMELINE_DATA = {
  list_timelines: [
    { name: "main", label: "Main", is_active: true, snapshot_count: 5, color_index: 0 },
    { name: "timeline/experiment", label: "Experiment", is_active: false, snapshot_count: 3, color_index: 1 },
    { name: "timeline/client-feedback", label: "Client Feedback", is_active: false, snapshot_count: 2, color_index: 2 },
  ],
};

const GRAPH_DATA = {
  get_graph: [
    { id: "g1", message: "Final polish", timestamp: "2025-01-15T14:00:00Z", timeline: "main", parents: ["g2"], lane: 0, is_head: true, is_branch_tip: true, author: "You" },
    { id: "g2", message: "Merge experiment", timestamp: "2025-01-15T13:00:00Z", timeline: "main", parents: ["g3", "g5"], lane: 0, is_head: false, author: "You" },
    { id: "g3", message: "Added feature section", timestamp: "2025-01-15T12:00:00Z", timeline: "main", parents: ["g4"], lane: 0, is_head: false, author: "You" },
    { id: "g4", message: "Initial draft", timestamp: "2025-01-15T10:00:00Z", timeline: "main", parents: [], lane: 0, is_head: false, author: "You" },
    { id: "g5", message: "Experiment: new intro", timestamp: "2025-01-15T12:30:00Z", timeline: "timeline/experiment", parents: ["g6"], lane: 1, is_head: false, is_branch_tip: true, author: "You" },
    { id: "g6", message: "Experiment: start", timestamp: "2025-01-15T11:00:00Z", timeline: "timeline/experiment", parents: ["g4"], lane: 1, is_head: false, author: "You" },
    { id: "g7", message: "Client feedback notes", timestamp: "2025-01-15T13:30:00Z", timeline: "timeline/client-feedback", parents: ["g3"], lane: 2, is_head: false, is_branch_tip: true, author: "Reviewer" },
  ],
};

const MERGE_CONFLICT_DATA = {
  merge_timelines: {
    status: "conflicts",
    conflicts: [
      {
        path: "sketches/demo-introduction.sk",
        file_type: "sketch",
        ours: JSON.stringify({ title: "Demo Introduction", description: "Full walkthrough" }),
        theirs: JSON.stringify({ title: "Product Demo", description: "Quick overview" }),
        ancestor: JSON.stringify({ title: "Untitled", description: "" }),
        field_conflicts: [
          { field_path: "title", ours: "Demo Introduction", theirs: "Product Demo", ancestor: "Untitled" },
          { field_path: "description", ours: "Full walkthrough of all features", theirs: "Quick overview for stakeholders", ancestor: "" },
        ],
        text_conflicts: [],
      },
      {
        path: "notes/script-draft.md",
        file_type: "note",
        ours: "# Script\n\nWelcome to our demo!",
        theirs: "# Script\n\nHello everyone!",
        ancestor: "# Script",
        field_conflicts: [],
        text_conflicts: [
          {
            start_line: 2,
            ours_lines: ["Welcome to our demo!", "Today we'll cover all the key features."],
            theirs_lines: ["Hello everyone!", "Let me show you what's new in this release."],
            ancestor_lines: ["Welcome."],
          },
        ],
      },
    ],
  },
};

// ── Test suite ───────────────────────────────────────────

test.use({ viewport: { width: 1920, height: 1080 } });

test.describe("Documentation Screenshots (1920×1080)", () => {
  
  test("01 — Home screen", async ({ page }) => {
    await goHome(page);
    await snap(page, "app-home");
  });

  test("02 — Sketch editor (full view)", async ({ page }) => {
    await setupApp(page);
    await openSketch(page, "Demo Introduction");
    await snap(page, "sketch-editor");
    await snap(page, "sketch-editor-full");
    await snap(page, "sketch-form");
  });

  test("03 — Sketch editor with sidebar detail", async ({ page }) => {
    await setupApp(page);
    await openSketch(page, "Demo Introduction");
    await snap(page, "sketch-sidebar");
  });

  test("04 — Sketch with chat panel", async ({ page }) => {
    await setupAppWithPanels(page);
    await openSketch(page, "Demo Introduction");
    await switchSecondaryTab(page, "Chat");
    await snap(page, "sketch-with-chat");
    await snap(page, "app-overview");
  });

  test("05 — Storyboard view", async ({ page }) => {
    await setupApp(page);
    await page.getByRole("button", { name: /Full Demo Flow/ }).first().click();
    await page.waitForTimeout(500);
    await snap(page, "storyboard-view");
    await snap(page, "storyboard-full");
  });

  test("06 — Notes/markdown editor", async ({ page }) => {
    await setupApp(page);
    await page.getByRole("button", { name: /Script Draft/ }).first().click();
    await page.waitForTimeout(500);
    await snap(page, "note-editor");
    await snap(page, "notes-editor-full");
  });

  test("07 — File tree view", async ({ page }) => {
    await setupApp(page);
    // Switch to file tree mode
    await page.getByRole("button", { name: "File tree" }).click();
    await page.waitForTimeout(300);
    await snap(page, "file-tree-view");
    // Switch back to categorized
    await page.getByRole("button", { name: "Categorized list" }).click();
    await page.waitForTimeout(200);
  });

  test("08 — Settings: General", async ({ page }) => {
    await setupApp(page);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.waitForTimeout(400);
    await snap(page, "settings-panel");
    await snap(page, "settings-general");
  });

  test("09 — Settings: AI Provider", async ({ page }) => {
    await setupApp(page);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.waitForTimeout(400);
    await page.getByText("AI Provider").first().click();
    await page.waitForTimeout(300);
    await snap(page, "settings-ai-provider");
  });

  test("10 — Settings: Agents", async ({ page }) => {
    await setupApp(page);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.waitForTimeout(400);
    await page.getByText("Agents").first().click();
    await page.waitForTimeout(300);
    await snap(page, "settings-agents");
  });

  test("11 — Settings: Display", async ({ page }) => {
    await setupApp(page);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.waitForTimeout(400);
    await page.getByText("Display").first().click();
    await page.waitForTimeout(300);
    await snap(page, "settings-display");
  });

  test("12 — Settings: Feedback", async ({ page }) => {
    await setupApp(page);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.waitForTimeout(400);
    await page.getByText("Feedback").first().click();
    await page.waitForTimeout(300);
    await snap(page, "settings-feedback");
  });

  test("13 — Settings: Images", async ({ page }) => {
    await setupApp(page);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.waitForTimeout(400);
    await page.getByText("Images").first().click();
    await page.waitForTimeout(300);
    await snap(page, "settings-images");
  });

  test("14 — Snapshots panel", async ({ page }) => {
    await setupAppWithPanels(page);
    await openSketch(page, "Demo Introduction");
    await switchSecondaryTab(page, "Snapshots");
    await snap(page, "snapshots-panel");
  });

  test("15 — Snapshots with multi-timeline selector", async ({ page }) => {
    await setupAppWithPanels(page);
    await openSketch(page, "Demo Introduction");
    await switchSecondaryTab(page, "Snapshots");
    await setOverrides(page, MULTI_TIMELINE_DATA);

    // Refresh snapshots tab to pick up overrides
    await switchSecondaryTab(page, "Chat");
    await switchSecondaryTab(page, "Snapshots");
    await page.waitForTimeout(500);

    await snap(page, "snapshots-with-timelines");

    // Open the dropdown for timeline selector screenshot
    const branchBtn = page.locator("button").filter({ hasText: "Main" }).first();
    await branchBtn.click();
    await page.waitForTimeout(400);
    await snap(page, "timeline-selector");
  });

  test("16 — History graph", async ({ page }) => {
    await setupAppWithPanels(page);
    await openSketch(page, "Demo Introduction");
    await switchSecondaryTab(page, "Snapshots");
    await setOverrides(page, { ...MULTI_TIMELINE_DATA, ...GRAPH_DATA });

    // Refresh to pick up overrides
    await switchSecondaryTab(page, "Chat");
    await switchSecondaryTab(page, "Snapshots");
    await page.waitForTimeout(500);

    // Click History button
    await page.getByRole("button", { name: "History" }).click();
    await page.waitForTimeout(800);
    await snap(page, "history-graph");
  });

  test("17 — Merge conflict panel", async ({ page }) => {
    await setupAppWithPanels(page);
    await openSketch(page, "Demo Introduction");
    await switchSecondaryTab(page, "Snapshots");
    await setOverrides(page, { ...MULTI_TIMELINE_DATA, ...MERGE_CONFLICT_DATA });

    // Refresh to pick up overrides
    await switchSecondaryTab(page, "Chat");
    await switchSecondaryTab(page, "Snapshots");
    await page.waitForTimeout(500);

    // Open timeline dropdown and trigger merge
    const branchBtn = page.locator("button").filter({ hasText: "Main" }).first();
    await branchBtn.click();
    await page.waitForTimeout(300);
    await page.getByText("Experiment").first().hover();
    await page.waitForTimeout(500);

    // Handle confirm dialog
    page.on("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Merge", exact: true }).first().click();
    await page.waitForTimeout(1000);

    await snap(page, "merge-conflict-panel");

    // Cancel
    const cancelBtn = page.getByRole("button", { name: "Cancel" });
    if (await cancelBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await cancelBtn.click();
    }
  });

  test("18 — Feedback popover", async ({ page }) => {
    await setupApp(page);
    await page.getByRole("button", { name: "Send Feedback" }).click();
    await page.waitForTimeout(400);
    await snap(page, "feedback-popover");
    // Close by pressing Escape
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  });

  test("19 — Debug panel", async ({ page }) => {
    await setupApp(page);
    await openSketch(page, "Demo Introduction");
    // Toggle bottom panel open
    await page.getByRole("button", { name: /Toggle Panel/ }).click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Debug" }).click();
    await page.waitForTimeout(300);
    await snap(page, "debug-panel");
  });

  test("20 — Command palette", async ({ page }) => {
    await setupApp(page);
    await page.keyboard.press("Control+Shift+P");
    await page.waitForTimeout(400);
    await snap(page, "command-palette");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  });
});

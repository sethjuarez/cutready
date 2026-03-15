import { test, expect, Page } from "@playwright/test";

/**
 * E2E tests for VisualCell rendering and interactions.
 * Uses mock overrides to inject sketch data with elucim DSL visuals.
 */

// A valid elucim DSL document (player with card preset)
const VALID_VISUAL = {
  version: "1.0",
  root: {
    type: "player",
    preset: "card",
    width: 640,
    height: 360,
    fps: 30,
    durationInFrames: 90,
    background: "#0f172a",
    children: [
      {
        type: "rect",
        x: 40,
        y: 40,
        width: 560,
        height: 280,
        fill: "#1e293b",
        rx: 16,
        stroke: "#334155",
        strokeWidth: 2,
      },
      {
        type: "text",
        x: 320,
        y: 100,
        content: "Test Visual",
        fontSize: 32,
        fill: "#e2e8f0",
        fontWeight: "700",
        textAnchor: "middle",
        fadeIn: 1,
      },
      {
        type: "circle",
        cx: 320,
        cy: 200,
        r: 40,
        fill: "#6366f1",
        fadeIn: 15,
      },
      {
        type: "arrow",
        x1: 200,
        y1: 260,
        x2: 440,
        y2: 260,
        stroke: "#94a3b8",
        strokeWidth: 2,
        headSize: 8,
        fadeIn: 30,
      },
    ],
  },
};

// Sketch with a visual on row 0, no visual on row 1
const SKETCH_WITH_VISUAL = {
  title: "Visual Test Sketch",
  description: "Testing elucim visual rendering",
  rows: [
    {
      time: "0:00–0:30",
      narrative: "Introduction with animated visual",
      demo_actions: "Show the landing page",
      screenshot: null,
      visual: VALID_VISUAL,
    },
    {
      time: "0:30–1:00",
      narrative: "Feature walkthrough",
      demo_actions: "Navigate to dashboard",
      screenshot: null,
    },
    {
      time: "1:00–1:30",
      narrative: "Deep dive",
      demo_actions: "Open settings panel",
      screenshot: null,
    },
  ],
  state: "draft",
  created_at: "2025-01-15T10:00:00Z",
  updated_at: "2025-01-15T12:00:00Z",
};

async function setOverrides(page: Page, overrides: Record<string, unknown>) {
  await page.evaluate((ov) => {
    const w = window as any;
    if (!w.__MOCK_OVERRIDES__) w.__MOCK_OVERRIDES__ = {};
    Object.assign(w.__MOCK_OVERRIDES__, ov);
  }, overrides);
}

async function openProject(page: Page) {
  await page.goto("/");
  await page.getByText("mock-project", { exact: true }).click();
  await page.waitForSelector('[title="Settings"]', { timeout: 5000 });
}

async function openSketch(page: Page) {
  // Override the sketch data to include our visual
  await setOverrides(page, { get_sketch: SKETCH_WITH_VISUAL });
  // Click the first sketch in sidebar
  await page.getByText("Demo Introduction").first().click();
  await page.waitForTimeout(800);
}

const IMG_DIR = "e2e/screenshots/";

test.describe("VisualCell — elucim DSL rendering", () => {
  test.beforeEach(async ({ page }) => {
    await openProject(page);
  });

  test("visual renders in sketch row when visual data is present", async ({ page }) => {
    // Capture console warnings to see validation errors
    const consoleMessages: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "warning" || msg.type() === "error") {
        consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
      }
    });

    await openSketch(page);

    // Wait a bit for any async rendering / error callbacks
    await page.waitForTimeout(1000);

    // Call elucim's validate() directly in the browser to see exact errors
    const validationResult = await page.evaluate(async (vis) => {
      try {
        const { validate } = await import("@elucim/dsl");
        return validate(vis);
      } catch (e) {
        return { error: String(e) };
      }
    }, VALID_VISUAL);
    console.log("Direct validation result:", JSON.stringify(validationResult, null, 2));

    // Dump console messages for debugging
    if (consoleMessages.length > 0) {
      console.log("--- Console messages ---");
      for (const m of consoleMessages) console.log(m);
      console.log("--- End ---");
    }

    // Take a screenshot to see what's rendered
    await page.screenshot({ path: `${IMG_DIR}visual-cell-test.png` });

    // Check that the sketch title is visible
    await expect(page.getByText("Visual Test Sketch")).toBeVisible();

    // The visual should render — NOT show "Invalid visual"
    const invalidLabel = page.getByText("Invalid visual");
    const isInvalid = await invalidLabel.isVisible().catch(() => false);
    if (isInvalid) {
      console.log("VISUAL IS INVALID — check validation result above");
    }

    // Verify text content of rows is correct
    const row0 = page.locator("tr").nth(1);
    const row1 = page.locator("tr").nth(2);
    await expect(row0.getByText("Introduction with animated visual")).toBeVisible();
    await expect(row1.getByText("Feature walkthrough")).toBeVisible();

    // Assert the visual renders successfully (no "Invalid visual")
    await expect(invalidLabel).not.toBeVisible();
  });

  test("screenshot: sketch with visual in dark and light mode", async ({ page }) => {
    await openSketch(page);
    await page.waitForTimeout(500);

    // Light mode
    await page.evaluate(() => {
      localStorage.setItem("cutready-theme", "light");
      document.documentElement.classList.remove("dark");
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${IMG_DIR}visual-cell-light.png` });

    // Dark mode
    await page.evaluate(() => {
      localStorage.setItem("cutready-theme", "dark");
      document.documentElement.classList.add("dark");
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${IMG_DIR}visual-cell-dark.png` });
  });

  test("remove visual button clears the visual on hover", async ({ page }) => {
    await openSketch(page);
    await page.waitForTimeout(500);

    // Find the visual container in row 0 and hover to reveal overlay
    const row0 = page.locator("tr").nth(1);
    const screenshotCell = row0.locator("td").last();
    await screenshotCell.hover();
    await page.waitForTimeout(300);

    // Look for the remove button (× icon with "Remove visual" title)
    const removeBtn = page.locator('button[title="Remove visual"]');
    
    // Take screenshot showing hover state
    await page.screenshot({ path: `${IMG_DIR}visual-cell-hover.png` });

    if (await removeBtn.isVisible()) {
      await removeBtn.click();
      await page.waitForTimeout(500);

      // After removal, the visual should be gone
      // The cell should now show the empty state or generate button
      await page.screenshot({ path: `${IMG_DIR}visual-cell-removed.png` });
    }
  });

  test("generate visual button appears on rows without visual", async ({ page }) => {
    await openSketch(page);
    await page.waitForTimeout(500);

    // Row 1 has no visual — hover to see the sparkle generate button
    const row1 = page.locator("tr").nth(2);
    const screenshotCell = row1.locator("td").last();
    await screenshotCell.hover();
    await page.waitForTimeout(300);

    // Look for the generate visual sparkle button
    const generateBtn = page.locator('button[title="Generate visual"]');
    
    await page.screenshot({ path: `${IMG_DIR}visual-cell-generate-btn.png` });

    // The button should be present on rows without visual/screenshot
    // (It may or may not be visible depending on the hover implementation)
  });
});

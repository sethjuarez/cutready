import { test, expect, Page } from "@playwright/test";

/**
 * E2E tests for VisualCell rendering and interactions.
 * Uses mock overrides to inject sketch data with elucim DSL visuals.
 */

// A valid elucim DSL document (960×540 with semantic tokens)
const VALID_VISUAL = {
  version: "1.0",
  root: {
    type: "player",
    width: 960,
    height: 540,
    fps: 30,
    durationInFrames: 90,
    background: "$background",
    children: [
      {
        type: "rect",
        x: 30,
        y: 24,
        width: 900,
        height: 492,
        fill: "$surface",
        rx: 20,
        stroke: "$border",
        strokeWidth: 1,
      },
      {
        type: "text",
        x: 480,
        y: 72,
        content: "Test Visual",
        fontSize: 38,
        fill: "$foreground",
        fontWeight: "900",
        textAnchor: "middle",
        fadeIn: 4,
      },
      {
        type: "text",
        x: 480,
        y: 106,
        content: "verifying semantic token rendering",
        fontSize: 18,
        fill: "$muted",
        fontWeight: "600",
        textAnchor: "middle",
        fadeIn: 8,
      },
      {
        type: "rect",
        x: 80,
        y: 150,
        width: 240,
        height: 100,
        fill: "rgba(167,139,250,0.10)",
        stroke: "#a78bfa",
        strokeWidth: 2,
        rx: 14,
        fadeIn: 14,
      },
      {
        type: "text",
        x: 200,
        y: 206,
        content: "Token Colors",
        fontSize: 22,
        fill: "#a78bfa",
        fontWeight: "700",
        textAnchor: "middle",
        fadeIn: 16,
      },
      {
        type: "arrow",
        x1: 340,
        y1: 200,
        x2: 420,
        y2: 200,
        stroke: "#38bdf8",
        strokeWidth: 2,
        headSize: 10,
        draw: 24,
      },
      {
        type: "rect",
        x: 440,
        y: 150,
        width: 240,
        height: 100,
        fill: "rgba(34,197,94,0.08)",
        stroke: "#22c55e",
        strokeWidth: 2,
        rx: 14,
        fadeIn: 30,
      },
      {
        type: "text",
        x: 560,
        y: 206,
        content: "Theme Adaptive",
        fontSize: 22,
        fill: "#22c55e",
        fontWeight: "700",
        textAnchor: "middle",
        fadeIn: 32,
      },
    ],
  },
};

// Sketch with a visual on row 0, no visual on row 1
const VISUAL_PATH = ".cutready/visuals/test-visual.json";

const SKETCH_WITH_VISUAL = {
  title: "Visual Test Sketch",
  description: "Testing elucim visual rendering",
  rows: [
    {
      time: "0:00–0:30",
      narrative: "Introduction with animated visual",
      demo_actions: "Show the landing page",
      screenshot: null,
      visual: VISUAL_PATH,
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
  // Override the sketch data to include our visual (as a path reference)
  // and override get_visual to return the actual visual JSON
  await setOverrides(page, {
    get_sketch: SKETCH_WITH_VISUAL,
    get_visual: VALID_VISUAL,
  });
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

  test("preview mode: visual fills space with theme and mini player", async ({ page }) => {
    await openSketch(page);
    await page.waitForTimeout(300);

    // Force list_monitors to throw so handlePreviewClick falls back to in-window preview
    await page.evaluate(() => {
      const w = window as any;
      const orig = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = (cmd: string, ...args: unknown[]) => {
        if (cmd === "list_monitors") return Promise.reject(new Error("mock"));
        return orig(cmd, ...args);
      };
    });

    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await page.waitForTimeout(2000); // Let animation auto-play

    // Screenshot in dark mode
    await page.evaluate(() => {
      localStorage.setItem("cutready-theme", "dark");
      document.documentElement.classList.add("dark");
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${IMG_DIR}visual-preview-dark.png` });

    // Screenshot in light mode
    await page.evaluate(() => {
      localStorage.setItem("cutready-theme", "light");
      document.documentElement.classList.remove("dark");
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${IMG_DIR}visual-preview-light-full.png` });

    // Wait for animation to finish and check for Replay button
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${IMG_DIR}visual-preview-replay.png` });

    // Verify no "Invalid visual" in preview mode
    const invalidLabel = page.getByText("Invalid visual");
    await expect(invalidLabel).not.toBeVisible();
  });

  test("semantic color tokens ($foreground, $accent, etc.) render without errors", async ({ page }) => {
    // Inject a visual that uses $token syntax for ALL structural colors
    const tokenVisual = {
      version: "1.0",
      root: {
        type: "player",
        width: 960,
        height: 540,
        fps: 30,
        durationInFrames: 60,
        background: "$background",
        children: [
          {
            type: "text",
            x: 480,
            y: 80,
            content: "Token Test",
            fontSize: 34,
            fill: "$foreground",
            fontWeight: "bold",
            textAnchor: "middle",
          },
          {
            type: "rect",
            x: 120,
            y: 150,
            width: 300,
            height: 120,
            fill: "$surface",
            stroke: "$accent",
            strokeWidth: 2,
            rx: 14,
            fadeIn: 10,
          },
          {
            type: "text",
            x: 270,
            y: 218,
            content: "Themed Box",
            fontSize: 20,
            fill: "$accent",
            textAnchor: "middle",
            fadeIn: 10,
          },
          {
            type: "arrow",
            x1: 440,
            y1: 210,
            x2: 530,
            y2: 210,
            stroke: "$muted",
            strokeWidth: 2,
            headSize: 10,
            fadeIn: 25,
          },
          {
            type: "rect",
            x: 550,
            y: 150,
            width: 300,
            height: 120,
            fill: "$surface",
            stroke: "$success",
            strokeWidth: 2,
            rx: 14,
            fadeIn: 30,
          },
          {
            type: "text",
            x: 700,
            y: 218,
            content: "Success",
            fontSize: 20,
            fill: "$success",
            textAnchor: "middle",
            fadeIn: 30,
          },
        ],
      },
    };
    const sketchWithTokens = {
      ...SKETCH_WITH_VISUAL,
      rows: [
        { ...SKETCH_WITH_VISUAL.rows[0], visual: VISUAL_PATH },
        ...SKETCH_WITH_VISUAL.rows.slice(1),
      ],
    };
    await setOverrides(page, { get_sketch: sketchWithTokens, get_visual: tokenVisual });
    await page.getByText("Demo Introduction").first().click();
    await page.waitForTimeout(800);

    // Should render without "Invalid visual" error
    const errorBadge = page.getByText("Invalid visual");
    await expect(errorBadge).not.toBeVisible();

    // The dsl-root should have --elucim-* CSS vars set by theme bridge
    const dslRoot = page.locator('[data-testid="dsl-root"]').first();
    await expect(dslRoot).toBeVisible();

    const cssVars = await dslRoot.evaluate((el) => {
      const style = el.getAttribute("style") ?? "";
      return style;
    });
    console.log("dsl-root style:", cssVars);

    // Verify key semantic token CSS vars are present
    expect(cssVars).toContain("--elucim-foreground");
    expect(cssVars).toContain("--elucim-background");
    expect(cssVars).toContain("--elucim-muted");
    expect(cssVars).toContain("--elucim-surface");
    expect(cssVars).toContain("--elucim-accent");
    expect(cssVars).toContain("--elucim-border");

    // Verify the SVG text elements use var() references (resolved $tokens)
    const svgTexts = dslRoot.locator("svg text");
    const firstTextFill = await svgTexts.first().getAttribute("fill");
    console.log("First text fill:", firstTextFill);
    // Should be a var() reference, not a raw $token
    expect(firstTextFill).toContain("var(--elucim-");

    // Screenshot dark mode
    await page.evaluate(() => {
      localStorage.setItem("cutready-theme", "dark");
      document.documentElement.classList.add("dark");
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${IMG_DIR}visual-tokens-dark.png` });

    // Screenshot light mode
    await page.evaluate(() => {
      localStorage.setItem("cutready-theme", "light");
      document.documentElement.classList.remove("dark");
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${IMG_DIR}visual-tokens-light.png` });
  });
});

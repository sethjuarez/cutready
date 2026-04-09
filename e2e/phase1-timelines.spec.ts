/**
 * Phase 1 E2E tests — Timeline Switcher (solo mode).
 * Validates that timelines work without a remote configured.
 */
import { test, expect } from "@playwright/test";

test.describe("Phase 1 — Solo Timeline Switcher", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#root", { timeout: 10_000 });
    await page.getByText("mock-project", { exact: true }).click();
    await page.waitForSelector('[title="Settings"]', { timeout: 5_000 });
    await page.getByText("Demo Introduction").first().click();
    await page.waitForTimeout(500);
    await page.keyboard.press("Control+Shift+B");
    await page.waitForTimeout(300);
    await page.locator('button[title="More options"]').click();
    await page.getByText("Snapshots").click();
    await page.waitForTimeout(500);
  });

  test.afterEach(async ({ page }) => {
    // Clear mock overrides to prevent test pollution
    await page.evaluate(() => {
      const o = (window as any).__MOCK_OVERRIDES__;
      if (o) for (const k of Object.keys(o)) delete o[k];
    });
  });

  test("timeline selector hidden with single timeline", async ({ page }) => {
    // Default mock has 1 timeline → selector hidden
    const branchBtn = page.locator('button[title^="Branch:"]');
    await expect(branchBtn).not.toBeVisible();

    await page.screenshot({
      path: "e2e/screenshots/v0.5.0/snapshots-panel-solo.png",
    });
  });

  test("timeline selector visible with multiple timelines", async ({ page }) => {
    // Override list_timelines to return 2 timelines, then reload timelines
    await page.evaluate(() => {
      (window as any).__MOCK_OVERRIDES__["list_timelines"] = [
        { name: "main", label: "Main", is_active: true, snapshot_count: 3, color_index: 0 },
        { name: "timeline/fork-143022", label: "New direction", is_active: false, snapshot_count: 1, color_index: 1 },
      ];
    });
    // Re-trigger timeline load by toggling secondary panel
    await page.keyboard.press("Control+Shift+B");
    await page.waitForTimeout(200);
    await page.keyboard.press("Control+Shift+B");
    await page.waitForTimeout(200);
    await page.locator('button[title="More options"]').click();
    await page.getByText("Snapshots").click();
    await page.waitForTimeout(500);

    const branchBtn = page.locator('button[title^="Branch:"]');
    await expect(branchBtn).toBeVisible({ timeout: 3_000 });

    // Open the dropdown
    await branchBtn.click();
    await page.waitForTimeout(300);

    await page.screenshot({
      path: "e2e/screenshots/v0.5.0/timeline-switcher-solo.png",
    });
  });

  test("snapshot save dialog shows fork prompt when rewound", async ({ page }) => {
    // Override is_rewound to return true
    await page.evaluate(() => {
      (window as any).__MOCK_OVERRIDES__["is_rewound"] = true;
      (window as any).__MOCK_OVERRIDES__["has_unsaved_changes"] = true;
    });
    // Re-enter Snapshots to pick up the rewound state
    await page.keyboard.press("Control+Shift+B");
    await page.waitForTimeout(200);
    await page.keyboard.press("Control+Shift+B");
    await page.waitForTimeout(200);
    await page.locator('button[title="More options"]').click();
    await page.getByText("Snapshots").click();
    await page.waitForTimeout(500);

    // Ctrl+S opens the snapshot dialog
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(500);

    // Expect the fork naming input
    const forkInput = page.locator('input[placeholder="e.g. Alternative intro, V2 approach..."]');
    await expect(forkInput).toBeVisible({ timeout: 3_000 });

    await page.screenshot({
      path: "e2e/screenshots/v0.5.0/fork-created-from-rewound.png",
    });
  });
});

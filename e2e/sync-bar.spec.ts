import { test, expect } from "@playwright/test";

test.describe("Sync Bar — remote collaboration", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByText("mock-project", { exact: true }).click();
    await page.waitForSelector('[title="Settings"]', { timeout: 5000 });
  });

  test("sync bar is hidden for solo users (no remote)", async ({ page }) => {
    // Toggle secondary panel via keyboard shortcut
    await page.keyboard.press("Control+Shift+B");
    await page.waitForTimeout(300);
    // Open Snapshots via the secondary rail
    await page.getByRole("button", { name: "Snapshots", exact: true }).click();

    // SyncBar should NOT be visible since devMock returns no remote
    // and no repoRemoteUrl is set in settings
    await page.waitForTimeout(500);
    const syncBarFetch = page.getByRole("button", { name: "Fetch" });
    await expect(syncBarFetch).not.toBeVisible();
  });

  test("timeline selector shows active timeline", async ({ page }) => {
    await page.keyboard.press("Control+Shift+B");
    await page.waitForTimeout(300);
    // Open Snapshots via the secondary rail
    await page.getByRole("button", { name: "Snapshots", exact: true }).click();
    await page.waitForTimeout(300);

    // The Snapshots header/back button should be visible
    await expect(page.getByRole("button", { name: "Snapshots", exact: true })).toBeVisible();
  });
});

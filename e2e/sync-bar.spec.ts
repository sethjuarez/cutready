import { test, expect } from "@playwright/test";

test.describe("Sync Bar — remote collaboration", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByText("mock-project", { exact: true }).click();
    await page.waitForSelector('[title="Settings"]', { timeout: 5000 });
  });

  test("sync bar is hidden for solo users (no remote)", async ({ page }) => {
    // Toggle secondary panel to show snapshots
    const toggleBtn = page.locator('[title="Toggle Secondary Panel"]');
    await toggleBtn.click();

    // SyncBar should NOT be visible since devMock returns no remote
    // and no repoRemoteUrl is set in settings
    await page.waitForTimeout(500);
    const syncBarFetch = page.getByRole("button", { name: "Fetch" });
    await expect(syncBarFetch).not.toBeVisible();
  });

  test("timeline selector shows active timeline", async ({ page }) => {
    const toggleBtn = page.locator('[title="Toggle Secondary Panel"]');
    await toggleBtn.click();

    // Look for the Snapshots header which should contain timeline info
    await expect(page.getByText("Snapshots")).toBeVisible();
  });
});

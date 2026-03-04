import { test, expect } from "@playwright/test";

test.describe("Visual verification — new UI components", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByText("mock-project", { exact: true }).click();
    await page.waitForSelector('[title="Settings"]', { timeout: 5000 });
  });

  test("screenshot: Settings Repository tab", async ({ page }) => {
    await page.locator('[title="Settings"]').click();
    await page.getByRole("button", { name: "Repository" }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: "e2e/screenshots/settings-repo-tab.png", fullPage: true });
  });

  test("screenshot: Settings Repository tab — PAT selected", async ({ page }) => {
    await page.locator('[title="Settings"]').click();
    await page.getByRole("button", { name: "Repository" }).click();
    const patLabel = page.locator("label").filter({ hasText: "Personal Access Token" });
    await patLabel.click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: "e2e/screenshots/settings-repo-pat.png", fullPage: true });
  });

  test("screenshot: Snapshots panel with timeline selector", async ({ page }) => {
    // The secondary panel with Chat/Sessions/Snapshots tabs is on the right
    // It might already be visible, or we toggle it
    await page.locator('[title="Toggle Secondary Panel"]').click();
    await page.waitForTimeout(300);
    // Click the Snapshots tab within the secondary panel
    const snapshotsTab = page.locator("button, [role='tab']").filter({ hasText: "Snapshots" });
    await snapshotsTab.first().click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: "e2e/screenshots/snapshots-panel.png" });
  });

  test("screenshot: Full app layout with project open", async ({ page }) => {
    await page.waitForTimeout(500);
    await page.screenshot({ path: "e2e/screenshots/full-layout-project.png", fullPage: true });
  });
});

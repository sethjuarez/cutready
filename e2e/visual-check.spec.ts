import { test, expect } from "@playwright/test";

test.describe("Visual verification — new UI components", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByText("mock-project", { exact: true }).click();
    await page.waitForSelector('[title="Settings"]', { timeout: 5000 });
  });

  test("screenshot: Settings Git Remote tab", async ({ page }) => {
    await page.locator('[title="Workspace"]').click();
    await page.getByRole("button", { name: "Git Remote" }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: "e2e/screenshots/settings-repo-tab.png", fullPage: true });
  });

  test("screenshot: Settings Git Remote tab — PAT selected", async ({ page }) => {
    await page.locator('[title="Workspace"]').click();
    await page.getByRole("button", { name: "Git Remote" }).click();
    const patLabel = page.locator("label").filter({ hasText: "Personal Access Token" });
    await patLabel.click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: "e2e/screenshots/settings-repo-pat.png", fullPage: true });
  });

  test("screenshot: Snapshots panel with timeline selector", async ({ page }) => {
    // Toggle secondary panel via keyboard shortcut
    await page.keyboard.press("Control+Shift+B");
    await page.waitForTimeout(300);
    // Open Snapshots via the secondary rail
    await page.getByRole("button", { name: "Snapshots", exact: true }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: "e2e/screenshots/snapshots-panel.png" });
  });

  test("screenshot: Full app layout with project open", async ({ page }) => {
    await page.waitForTimeout(500);
    await page.screenshot({ path: "e2e/screenshots/full-layout-project.png", fullPage: true });
  });
});

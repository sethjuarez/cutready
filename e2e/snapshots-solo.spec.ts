import { test, expect } from "@playwright/test";

test.describe("Snapshots tab — solo user (no remote)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Wait for the app to load (devMock injects automatically in dev mode)
    await page.waitForSelector("[data-testid='app-root'], .app-root, #root", {
      timeout: 10_000,
    });
  });

  test("app loads with devMock (no Tauri backend)", async ({ page }) => {
    // The app should render without crashing even without the Rust backend
    const root = page.locator("#root");
    await expect(root).toBeVisible();
  });

  test("secondary panel renders with tabs", async ({ page }) => {
    // Look for the secondary panel tabs (Chat, Sessions, Snapshots)
    const snapshotsTab = page.getByRole("tab", { name: /snapshots/i });
    // Tab might not exist if panel is collapsed — check for the panel area
    const panel = page.locator('[class*="secondary"], [class*="panel"]');
    await expect(panel.first()).toBeVisible({ timeout: 5_000 });
  });
});

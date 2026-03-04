import { test, expect } from "@playwright/test";

test.describe("Phase 0 — Snapshot UX", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#root", { timeout: 10_000 });
    // Open a mock project to get the full editor + sidebar
    await page.getByText("mock-project", { exact: true }).click();
    await page.waitForSelector('[title="Settings"]', { timeout: 5_000 });
    // Open a sketch so the editor area loads
    await page.getByText("Demo Introduction").first().click();
    await page.waitForTimeout(500);
    // Toggle secondary panel to make it visible
    const toggleBtn = page.locator('[title="Toggle Secondary Panel"]');
    await toggleBtn.click();
    await page.waitForTimeout(300);
    // Click the Snapshots button in the secondary panel tabs
    const snapshotsBtn = page.getByRole("button", { name: "Snapshots" });
    await snapshotsBtn.click();
    await page.waitForTimeout(500);
  });

  test("snapshot panel shows graph with nodes", async ({ page }) => {
    // Graph should show our 2 mock nodes
    await expect(page.getByText("Added feature section")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Initial draft")).toBeVisible();
  });

  test("save button opens snapshot dialog (Ctrl+S shortcut)", async ({ page }) => {
    // The Save button should be in the snapshots panel header
    const saveBtn = page.locator('button[title*="Save Project Snapshot"]');
    await expect(saveBtn).toBeVisible({ timeout: 5_000 });
    await saveBtn.click();
    // Snapshot dialog should appear with the snapshot name input
    const nameInput = page.locator('input[placeholder*="Added intro sketch"]');
    await expect(nameInput).toBeVisible({ timeout: 3_000 });
  });

  test("search button toggles filter bar", async ({ page }) => {
    // Click search button
    const searchBtn = page.locator('button[title="Search snapshots"]');
    await expect(searchBtn).toBeVisible({ timeout: 5_000 });
    await searchBtn.click();
    // Filter input should appear
    const filterInput = page.locator('input[placeholder*="Filter snapshots"]');
    await expect(filterInput).toBeVisible();
    // Type a search that won't match
    await filterInput.fill("nonexistent");
    await expect(page.getByText('No snapshots match')).toBeVisible();
    // Clear and close
    await searchBtn.click();
    await expect(filterInput).not.toBeVisible();
  });

  test("search filters snapshot nodes", async ({ page }) => {
    const searchBtn = page.locator('button[title="Search snapshots"]');
    await searchBtn.click();
    const filterInput = page.locator('input[placeholder*="Filter snapshots"]');
    // Filter to match only one node
    await filterInput.fill("Initial");
    // "Initial draft" should still be visible, "Added feature section" should not
    await expect(page.getByText("Initial draft")).toBeVisible();
    await expect(page.getByText("Added feature section")).not.toBeVisible();
  });

  test("timeline selector hidden with single timeline", async ({ page }) => {
    // With only one timeline (main), TimelineSelector should NOT be visible
    const branchBtn = page.locator('button[title^="Timeline:"]');
    await expect(branchBtn).not.toBeVisible();
  });

  test("discard button only visible when dirty", async ({ page }) => {
    // Discard button should NOT be visible (mock has isDirty=false)
    const discardBtn = page.locator('button[title="Discard changes"]');
    await expect(discardBtn).not.toBeVisible();
  });
});

import { expect, test } from "@playwright/test";

test.describe("P1 confidence workflows", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#root", { timeout: 10_000 });
    await page.getByText("mock-project", { exact: true }).click();
    await page.waitForSelector('[title="Settings"]', { timeout: 5_000 });
  });

  test("Ctrl+S opens the snapshot naming dialog and cancel dismisses without saving", async ({ page }) => {
    await page.keyboard.press("Control+S");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("heading", { name: "Save Snapshot" })).toBeVisible();
    await expect(page.getByLabel("Snapshot name")).toBeFocused();

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  });
});

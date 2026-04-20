import { expect, test } from "@playwright/test";

test.describe("P0 confidence workflows", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#root", { timeout: 10_000 });
    await page.getByText("mock-project", { exact: true }).click();
    await page.waitForSelector('[title="Settings"]', { timeout: 5_000 });
  });

  test("storyboard description keeps focus while typing a full sentence", async ({ page }) => {
    await page.getByText("Full Demo Flow").first().click();

    await page.getByText("End-to-end walkthrough of the platform's key features").click();
    const editor = page.getByPlaceholder("Describe this storyboard...");
    await expect(editor).toBeFocused();

    const description = "This full sentence should stay focused while the debounce save waits.";
    await editor.fill("");
    await editor.pressSequentially(description, { delay: 5 });

    await expect(editor).toHaveValue(description);
    await expect(editor).toBeFocused();
    await page.waitForTimeout(900);
    await expect(editor).toHaveValue(description);
    await expect(editor).toBeFocused();
  });
});

import { test, expect } from "@playwright/test";

test.describe("Settings → Git Remote tab", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Open the mock project from the home screen
    await page.getByText("mock-project", { exact: true }).click();
    // Wait for sidebar to appear (project loaded)
    await page.waitForSelector('[title="Settings"]', { timeout: 5000 });
  });

  /** Click the sidebar Workspace button, then the Git Remote tab */
  async function openRepoSettings(page: import("@playwright/test").Page) {
    await page.locator('[title="Workspace"]').click();
    const repoTab = page.getByRole("button", { name: "Git Remote" });
    await expect(repoTab).toBeVisible({ timeout: 3000 });
    await repoTab.click();
  }

  test("navigates to Workspace Settings and shows Git Remote tab", async ({ page }) => {
    await openRepoSettings(page);

    await expect(page.getByText("Remote URL")).toBeVisible();
    await expect(page.getByText("Authentication")).toBeVisible();
    await expect(page.getByText("Git Identity")).toBeVisible();
  });

  test("shows auth method radio cards", async ({ page }) => {
    await openRepoSettings(page);

    await expect(page.getByText("GitHub CLI (gh)")).toBeVisible();
    await expect(page.getByText("Personal Access Token")).toBeVisible();
    await expect(page.getByText("SSH Key", { exact: true })).toBeVisible();
  });

  test("PAT field appears when PAT auth selected", async ({ page }) => {
    await openRepoSettings(page);

    // PAT field hidden by default
    await expect(page.getByPlaceholder("ghp_xxxxxxxxxxxx")).not.toBeVisible();

    // Select PAT radio
    const patLabel = page.locator("label").filter({ hasText: "Personal Access Token" });
    await patLabel.click();

    // PAT input appears
    await expect(page.getByPlaceholder("ghp_xxxxxxxxxxxx")).toBeVisible();
  });

  test("remote URL input and test button exist", async ({ page }) => {
    await openRepoSettings(page);

    await expect(page.getByPlaceholder("https://github.com/user/repo.git")).toBeVisible();
    await expect(page.getByRole("button", { name: "Test" })).toBeVisible();
  });

  test("git identity fields exist", async ({ page }) => {
    await openRepoSettings(page);

    await expect(page.getByPlaceholder("Name")).toBeVisible();
    await expect(page.getByPlaceholder("email@example.com")).toBeVisible();
  });
});

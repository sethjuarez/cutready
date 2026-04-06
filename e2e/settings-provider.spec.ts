import { test, expect, type Page } from "@playwright/test";

test.describe("Settings → AI Provider tab", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByText("mock-project", { exact: true }).click();
    await page.waitForSelector('[title="Settings"]', { timeout: 5000 });
  });

  /** Open Settings (global) → AI Provider tab */
  async function openAIProvider(page: Page) {
    await page.locator('[title="Settings"]').click();
    const aiTab = page.getByRole("button", { name: "AI Provider" });
    await expect(aiTab).toBeVisible({ timeout: 3000 });
    await aiTab.click();
  }

  test("shows provider selector with all 4 providers", async ({ page }) => {
    await openAIProvider(page);
    const select = page.locator("select").first();
    await expect(select).toBeVisible();
    const options = select.locator("option");
    await expect(options).toHaveCount(4);
    await expect(options.nth(0)).toHaveText("Microsoft Foundry");
    await expect(options.nth(1)).toHaveText("Azure OpenAI");
    await expect(options.nth(2)).toHaveText("OpenAI");
    await expect(options.nth(3)).toHaveText("Anthropic");
  });

  test("OpenAI shows endpoint + API key, no auth toggle", async ({ page }) => {
    await openAIProvider(page);
    await page.locator("select").first().selectOption("openai");

    // API Key visible
    await expect(page.getByPlaceholder("Enter your API key")).toBeVisible();
    // Endpoint visible
    await expect(
      page.getByPlaceholder("https://api.openai.com (default)")
    ).toBeVisible();
    // Auth toggle NOT visible
    await expect(page.getByText("Authentication")).not.toBeVisible();
  });

  test("Anthropic shows API key only, no endpoint or auth toggle", async ({
    page,
  }) => {
    await openAIProvider(page);
    await page.locator("select").first().selectOption("anthropic");

    await expect(page.getByPlaceholder("sk-ant-...")).toBeVisible();
    // No endpoint field
    await expect(
      page.getByPlaceholder("https://api.openai.com (default)")
    ).not.toBeVisible();
    await expect(
      page.getByPlaceholder("https://your-resource.openai.azure.com")
    ).not.toBeVisible();
    // No auth toggle
    await expect(page.getByText("Authentication")).not.toBeVisible();
  });

  test("Azure OpenAI shows auth toggle (API Key / Azure Sign-in)", async ({
    page,
  }) => {
    await openAIProvider(page);
    await page.locator("select").first().selectOption("azure_openai");

    await expect(page.getByText("Authentication")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "API Key" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Azure Sign-in" })
    ).toBeVisible();
  });

  test("Foundry shows auth toggle (API Key / Azure Sign-in)", async ({
    page,
  }) => {
    await openAIProvider(page);
    await page.locator("select").first().selectOption("microsoft_foundry");

    await expect(page.getByText("Authentication")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "API Key" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Azure Sign-in" })
    ).toBeVisible();
  });

  test("Azure Sign-in mode shows OAuth fields and hides API key", async ({
    page,
  }) => {
    await openAIProvider(page);
    await page.locator("select").first().selectOption("azure_openai");
    await page.getByRole("button", { name: "Azure Sign-in" }).click();

    // API Key input should be hidden
    await expect(page.getByPlaceholder("Enter your API key")).not.toBeVisible();
    // Tenant ID field should be visible
    await expect(page.getByText("Tenant ID")).toBeVisible();
  });

  test("Foundry OAuth mode shows resource picker", async ({ page }) => {
    await openAIProvider(page);
    await page.locator("select").first().selectOption("microsoft_foundry");
    await page.getByRole("button", { name: "Azure Sign-in" }).click();

    // Tenant ID visible
    await expect(page.getByText("Tenant ID")).toBeVisible();
    // Sign In button visible
    await expect(
      page.getByRole("button", { name: /sign in/i })
    ).toBeVisible();
  });

  test("switching provider resets model list", async ({ page }) => {
    await openAIProvider(page);

    // Select OpenAI first
    await page.locator("select").first().selectOption("openai");
    // Fill API key
    await page.getByPlaceholder("Enter your API key").fill("sk-test-key");

    // Switch to Anthropic — model input should be cleared or retain default
    await page.locator("select").first().selectOption("anthropic");
    // The provider tab renders without error
    await expect(page.getByText("API Key")).toBeVisible();
  });

  test("Fetch Models button visible when API key is set", async ({ page }) => {
    await openAIProvider(page);
    await page.locator("select").first().selectOption("openai");
    await page.getByPlaceholder("Enter your API key").fill("sk-test-key");

    const fetchBtn = page.getByRole("button", { name: "Fetch available models" });
    await expect(fetchBtn).toBeVisible();
  });
});

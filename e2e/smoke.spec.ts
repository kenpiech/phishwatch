import { clerk } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";
import { USER_A } from "./users";

test("signed out: the landing page, no data", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /lookalike domains/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /sign in to start watching/i })).toBeVisible();
});

test("signed in: add a brand, see the scanner live, remove the brand", async ({ page }) => {
  await page.goto("/");
  await clerk.signIn({ page, emailAddress: USER_A });
  await page.goto("/");

  // the status bar comes from runs over RLS + Realtime: proves the Clerk token works in Supabase
  await expect(page.getByTestId("status-fresh")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("status-fresh")).toContainText(/certificates checked today/);

  // leftovers from an interrupted earlier run
  page.on("dialog", (d) => d.accept());
  const leftovers = page.getByRole("button", { name: /^Stop watching (Smoke|Long|Iso|Diag) / });
  await expect(page.getByText(/Your brands/i)).toBeVisible();
  while ((await leftovers.count()) > 0) {
    const n = await leftovers.count();
    await leftovers.first().click();
    await expect(leftovers).toHaveCount(n - 1);
  }

  const name = `Smoke ${Date.now()}`;
  const chip = page.getByRole("button", { name: `Stop watching ${name}` });
  if (!(await page.getByLabel("Brand name").isVisible())) await page.getByRole("button", { name: /add a brand/i }).click();
  await page.getByLabel("Brand name").fill(name);
  await page.getByLabel(/official domains/i).fill("smoke-test-brand.example");
  await expect(page.getByLabel(/terms to look for/i)).toHaveValue("smoke-test-brand");
  await page.getByRole("button", { name: "Start watching" }).click();
  await expect(chip).toBeVisible();
  await expect(page.getByTestId("feed-empty")).toContainText(/No lookalikes yet/);

  await chip.click();
  await expect(chip).toHaveCount(0);
});

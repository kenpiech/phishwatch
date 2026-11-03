// Clerk session tokens expire after ~60 s. A page left open past that must keep receiving
// matches, which means the Realtime socket keeps re-authenticating with fresh tokens.

import { clerk } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";
import { USER_A } from "./users";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const OPEN_FOR_MS = 210_000; // 3.5 minutes: at least three Clerk token rotations

test("a match still arrives live after the page has been open 3.5 minutes", async ({ page }) => {
  test.setTimeout(OPEN_FOR_MS + 90_000);
  page.on("dialog", (d) => d.accept());
  await page.goto("/");
  await clerk.signIn({ page, emailAddress: USER_A });
  await page.goto("/");
  await expect(page.getByTestId("status-fresh")).toBeVisible({ timeout: 30_000 });

  const leftovers = page.getByRole("button", { name: /^Stop watching (Smoke|Long|Iso|Diag) / });
  while ((await leftovers.count()) > 0) {
    const n = await leftovers.count();
    await leftovers.first().click();
    await expect(leftovers).toHaveCount(n - 1);
  }
  const stamp = Date.now();
  const brand = `Long ${stamp}`;
  if (!(await page.getByLabel("Brand name").isVisible())) await page.getByRole("button", { name: /add a brand/i }).click();
  await page.getByLabel("Brand name").fill(brand);
  await page.getByLabel(/official domains/i).fill("long-session.example");
  await page.getByRole("button", { name: "Start watching" }).click();
  await expect(page.getByRole("button", { name: `Stop watching ${brand}` })).toBeVisible();

  await page.waitForTimeout(OPEN_FOR_MS); // the token the socket opened with has long expired
  await expect(page.getByTestId("status-fresh")).toBeVisible(); // runs kept arriving the whole time

  const token = await page.evaluate(() => window.Clerk.session!.getToken());
  const watches = await (await fetch(`${SUPABASE_URL}/rest/v1/watches?select=id&name=eq.${encodeURIComponent(brand)}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
  })).json();
  const domain = `long-session-${stamp}.invalid`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/pw_test_insert_hit`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_watch_id: watches[0].id, p_domain: domain }),
  });
  expect(res.status).toBe(200);
  await expect(page.getByTestId("hit-domain").filter({ hasText: domain.replace(/\.invalid$/, "[.]invalid") })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: `Stop watching ${brand}` }).click();
});

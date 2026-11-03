// Two signed-in people at once, each in their own browser context:
//   - A never sees B's brands or matches, in the page or through the API with A's own token
//   - a match created for A's brand appears on A's page without a refresh, with a toast
//   - B can't create a match on A's brand

import { clerk } from "@clerk/testing/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { USER_A, USER_B } from "./users";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

async function signedInPage(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto("/");
  await clerk.signIn({ page, emailAddress: email });
  await page.goto("/");
  await expect(page.getByTestId("status-fresh")).toBeVisible({ timeout: 30_000 });
  return page;
}

// Call Supabase's REST API as the user signed in on `page`, with their current Clerk token.
async function api(page: Page, path: string, init: RequestInit = {}) {
  const token = await page.evaluate(() => window.Clerk.session!.getToken());
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function removeTestBrands(page: Page, prefix: string) {
  const buttons = page.getByRole("button", { name: new RegExp(`^Stop watching ${prefix}`) });
  await expect(page.getByText(/Your brands/i)).toBeVisible();
  while ((await buttons.count()) > 0) {
    const n = await buttons.count();
    await buttons.first().click();
    await expect(buttons).toHaveCount(n - 1);
  }
}

async function addBrand(page: Page, name: string, domain: string) {
  if (!(await page.getByLabel("Brand name").isVisible())) await page.getByRole("button", { name: /add a brand/i }).click();
  await page.getByLabel("Brand name").fill(name);
  await page.getByLabel(/official domains/i).fill(domain);
  await page.getByRole("button", { name: "Start watching" }).click();
  await expect(page.getByRole("button", { name: `Stop watching ${name}` })).toBeVisible();
}

test("A and B see only their own data; A's new match arrives live", async ({ browser }) => {
  const a = await signedInPage(browser, USER_A);
  const b = await signedInPage(browser, USER_B);
  await removeTestBrands(a, "(Smoke|Long|Iso|Diag) ");
  await removeTestBrands(b, "(Smoke|Long|Iso|Diag) ");

  const stamp = Date.now();
  const brandA = `Iso A ${stamp}`;
  const brandB = `Iso B ${stamp}`;
  await addBrand(a, brandA, "isolation-alpha.example");
  await addBrand(b, brandB, "isolation-bravo.example");

  // ---- isolation in the page
  await expect(a.getByText(brandB)).toHaveCount(0);
  await expect(b.getByText(brandA)).toHaveCount(0);

  // ---- isolation through the API, with each user's own token
  const watchesA = (await api(a, "watches?select=id,name")).body as { id: string; name: string }[];
  const watchesB = (await api(b, "watches?select=id,name")).body as { id: string; name: string }[];
  expect(watchesA.map((w) => w.name)).toContain(brandA);
  expect(watchesA.map((w) => w.name)).not.toContain(brandB);
  expect(watchesB.map((w) => w.name)).not.toContain(brandA);
  const watchIdA = watchesA.find((w) => w.name === brandA)!.id;

  // ---- a match for A's brand appears on A's page without a reload
  const domain = `isolation-alpha-login-${stamp}.invalid`;
  const urlBefore = a.url();
  const inserted = await api(a, "rpc/pw_test_insert_hit", {
    method: "POST",
    body: JSON.stringify({ p_watch_id: watchIdA, p_domain: domain }),
  });
  expect(inserted.status).toBe(200);

  const defanged = domain.replace(/\.invalid$/, "[.]invalid");
  await expect(a.getByTestId("hit-domain").filter({ hasText: defanged })).toBeVisible({ timeout: 15_000 });
  await expect(a.getByTestId("toast").filter({ hasText: brandA })).toBeVisible();
  expect(a.url()).toBe(urlBefore); // same page: it arrived over the WebSocket

  // ---- B never sees it: not in B's page, not through B's API
  await b.waitForTimeout(3_000); // give Realtime a chance to (wrongly) deliver it
  await expect(b.getByText(defanged)).toHaveCount(0);
  const hitsAsB = await api(b, `hits?select=id&watch_id=eq.${watchIdA}`);
  expect(hitsAsB.body).toEqual([]);
  const watchAsB = await api(b, `watches?select=id&id=eq.${watchIdA}`);
  expect(watchAsB.body).toEqual([]);

  // ---- B can't plant a match on A's brand
  const planted = await api(b, "rpc/pw_test_insert_hit", {
    method: "POST",
    body: JSON.stringify({ p_watch_id: watchIdA, p_domain: `planted-${stamp}.invalid` }),
  });
  expect(planted.status).toBe(403);
  expect(JSON.stringify(planted.body)).toContain("not your watch");

  // ---- and nobody can write hits directly
  const direct = await api(a, "hits", {
    method: "POST",
    body: JSON.stringify({ watch_id: watchIdA, domain: "direct.invalid", score: 9, severity: "likely", entry_ts: new Date().toISOString(), log_index: 0, last_seen_at: new Date().toISOString() }),
  });
  expect(direct.status).toBe(403);

  // ---- clean up (deleting a brand cascades to its matches)
  await removeTestBrands(a, "Iso ");
  await removeTestBrands(b, "Iso ");
});

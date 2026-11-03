// When the Realtime server closes a channel (as it does when a token expires), realtime-js
// doesn't rejoin it by itself; the page must rebuild the channel and carry on. This test feeds
// the page's socket the exact frames the server sent in a recorded failure, through the same
// entry point real server messages use, then checks the page rejoins and runs keep arriving.

import { clerk } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";
import { USER_A } from "./users";

test("a channel the server closes is rebuilt, and runs keep arriving", async ({ page }) => {
  test.skip(!!process.env.PW_BASE_URL, "uses a development-only hook, stripped from production builds");
  const joins: { ref: string; topic: string; at: number }[] = []; // phx_join frames the page sends for runs channels
  page.on("websocket", (ws) => {
    if (!ws.url().includes("/realtime/")) return;
    ws.on("framesent", ({ payload }) => {
      const text = typeof payload === "string" ? payload : payload.toString("utf8");
      let frame: unknown[];
      try {
        frame = JSON.parse(text);
      } catch {
        return; // not a JSON frame
      }
      if (String(frame[2]).startsWith("realtime:runs-") && frame[3] === "phx_join") joins.push({ ref: String(frame[0]), topic: String(frame[2]), at: Date.now() });
    });
  });

  await page.goto("/");
  await clerk.signIn({ page, emailAddress: USER_A });
  await page.goto("/");
  await expect(page.getByTestId("status-fresh")).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => joins.length).toBeGreaterThan(0);

  // what the server sent at 151.6 s in the recorded failure, addressed to the live runs channel
  // give the page's last (surviving) runs channel time to settle, then target it
  await page.waitForTimeout(2_000);
  const { ref, topic } = joins[joins.length - 1];
  const closedAt = Date.now();
  await page.evaluate(({ ref, topic }) => {
    const client = (window as unknown as { __phishwatchSupabase: { realtime: { socketAdapter: { getSocket(): { onConnMessage(e: { data: string }): void } } } } }).__phishwatchSupabase;
    const socket = client.realtime.socketAdapter.getSocket();
    socket.onConnMessage({ data: JSON.stringify([ref, null, topic, "system", { message: "Token has expired 0 seconds ago", status: "error", extension: "system", channel: topic.replace(/^realtime:/, "") }]) });
    socket.onConnMessage({ data: JSON.stringify([ref, ref, topic, "phx_close", {}]) });
  }, { ref, topic });

  // the page notices...
  await expect(page.getByText("Reconnecting…")).toBeVisible();
  // ...rejoins within a few seconds (the first rebuild waits 2 s)...
  await expect.poll(() => joins.filter((j) => j.at > closedAt).length, { timeout: 10_000 }).toBeGreaterThan(0);
  // ...and is live again, with new runs arriving ("N s ago" back under 10 s)
  await expect(page.getByText("Reconnecting…")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId("status-fresh")).toContainText(/· [0-9] s ago/, { timeout: 15_000 });
});

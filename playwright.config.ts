import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";

// The Clerk and Supabase keys come from .env.local (gitignored); they're read here only so
// the test process can mint Clerk testing tokens. They are never printed.
loadEnv({ path: ".env.local", quiet: true });

const PORT = 3100;
// PW_BASE_URL=https://phishwatch-umber.vercel.app npx playwright test  -> run against production
const REMOTE = process.env.PW_BASE_URL;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: REMOTE ?? `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /global\.setup\.ts/ },
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, dependencies: ["setup"] },
  ],
  webServer: REMOTE
    ? undefined
    : {
        command: `npx next dev --port ${PORT}`,
        url: `http://localhost:${PORT}`,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});

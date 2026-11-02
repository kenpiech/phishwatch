import { clerkSetup } from "@clerk/testing/playwright";
import { test as setup } from "@playwright/test";

// Fetches a Clerk testing token so automated sign-ins skip bot protection (dev instance only).
setup("clerk testing token", async () => {
  await clerkSetup({ publishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY });
});

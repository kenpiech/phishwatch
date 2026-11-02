"use client";

// Client-side root: signed out -> landing, signed in -> dashboard. Everything signed-in
// runs in the browser (RLS-checked queries + Realtime), so the server never reads the session.

import { useAuth } from "@clerk/nextjs";
import { Dashboard } from "./Dashboard";
import { Landing } from "./Landing";

export function PhishwatchApp() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-zinc-500" role="status">
        Loading…
      </div>
    );
  }
  return isSignedIn ? <Dashboard /> : <Landing />;
}

"use client";

// The browser's Supabase client. Every request, and the Realtime socket, carries the signed-in
// user's Clerk session token; Supabase verifies it (third-party auth) and RLS keys on its `sub`.

import { getToken, useAuth } from "@clerk/nextjs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useMemo } from "react";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const TOKEN_CHECK_MS = 10_000;

export function useSupabase(): SupabaseClient | null {
  const { isSignedIn, userId } = useAuth();

  // One client per signed-in user. createClient opens no connection until a channel subscribes.
  // Clerk tokens live ~60 s, so supabase-js asks for the current one before each request and
  // whenever the Realtime socket (re)authenticates; Clerk's getToken() returns a fresh one.
  const client = useMemo(() => {
    if (!isSignedIn || !userId) return null;
    if (!URL || !KEY) throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are not set");
    return createClient(URL, KEY, { accessToken: async () => (await getToken()) ?? null });
  }, [isSignedIn, userId]);

  // realtime-js only re-reads the token on its 25 s heartbeat, but Clerk can rotate it as
  // little as ~18 s before the old one expires: then the server closes every channel with
  // "Token has expired". Offering the current token every 10 s closes that gap. setAuth()
  // asks the accessToken callback and sends a frame only if the token actually changed.
  useEffect(() => {
    if (!client) return;
    // Development builds only (stripped from production): lets the Playwright recovery test
    // feed the socket a server frame, the way a real "Token has expired" close arrives.
    if (process.env.NODE_ENV !== "production") (window as { __phishwatchSupabase?: SupabaseClient }).__phishwatchSupabase = client;
    const id = setInterval(() => void client.realtime.setAuth(), TOKEN_CHECK_MS);
    // No removeAllChannels() here: it disconnects the socket asynchronously, after a re-mounted
    // component may already have queued a join on it. Each channel's owner removes its own, and
    // realtime-js closes the idle socket by itself 50 s after the last channel leaves.
    return () => clearInterval(id);
  }, [client]);
  return client;
}

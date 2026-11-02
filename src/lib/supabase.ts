"use client";

// The browser's Supabase client. Every request, and the Realtime socket, carries the signed-in
// user's Clerk session token; Supabase verifies it (third-party auth) and RLS keys on its `sub`.

import { getToken, useAuth } from "@clerk/nextjs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useMemo } from "react";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

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

  useEffect(() => () => void client?.removeAllChannels(), [client]);
  return client;
}

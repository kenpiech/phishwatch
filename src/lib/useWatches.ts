"use client";

// The signed-in user's watches (RLS returns only their own) and the presets.

import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import { MAX_WATCHES, validateWatch, type WatchInput } from "./display.ts";
import type { Preset, Watch } from "./types.ts";

// Turn database errors into sentences. The checks are mirrored in validateWatch, so these are
// a backstop (e.g. two tabs adding at once past the 5-watch limit).
function friendly(message: string): string {
  if (/at most 5 brands/.test(message)) return "You can watch at most 5 brands. Remove one first.";
  if (/violates check constraint/.test(message)) return "That brand doesn't pass validation. Check the domains and terms.";
  if (/JWT|permission denied|row-level security/i.test(message)) return "Your session couldn't be verified. Try signing out and in again.";
  return message;
}

export function useWatches(supabase: SupabaseClient | null) {
  const [watches, setWatches] = useState<Watch[] | null>(null); // null = loading
  const [presets, setPresets] = useState<Preset[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const [w, p] = await Promise.all([
      supabase.from("watches").select("id, name, official_domains, terms, created_at").order("created_at"),
      supabase.from("presets").select("id, name, official_domains, terms").order("id"),
    ]);
    if (w.error || p.error) {
      setError(friendly((w.error ?? p.error)!.message));
      return;
    }
    setError(null);
    setWatches(w.data as Watch[]);
    setPresets(p.data as Preset[]);
  }, [supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading data from an external system on mount
    void load();
  }, [load]);

  // Returns an error message, or null on success.
  const add = useCallback(
    async (input: WatchInput): Promise<string | null> => {
      if (!supabase) return "Not signed in.";
      if ((watches?.length ?? 0) >= MAX_WATCHES) return `You can watch at most ${MAX_WATCHES} brands. Remove one first.`;
      const invalid = validateWatch(input);
      if (invalid) return invalid;
      const { data, error } = await supabase
        .from("watches")
        .insert({ name: input.name.trim(), official_domains: input.official_domains, terms: input.terms })
        .select("id, name, official_domains, terms, created_at")
        .single();
      if (error) return friendly(error.message);
      setWatches((ws) => [...(ws ?? []), data as Watch]);
      return null;
    },
    [supabase, watches],
  );

  const remove = useCallback(
    async (id: string): Promise<string | null> => {
      if (!supabase) return "Not signed in.";
      const { error } = await supabase.from("watches").delete().eq("id", id);
      if (error) return friendly(error.message);
      setWatches((ws) => (ws ?? []).filter((w) => w.id !== id));
      return null;
    },
    [supabase],
  );

  return { watches, presets, error, add, remove, reload: load };
}

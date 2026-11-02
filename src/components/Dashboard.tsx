"use client";

import { UserButton } from "@clerk/nextjs";
import { useSupabase } from "@/lib/supabase.ts";
import { useWatches } from "@/lib/useWatches.ts";
import { WatchesPanel } from "./WatchesPanel";

export function Dashboard() {
  const supabase = useSupabase();
  const { watches, presets, error, add, remove } = useWatches(supabase);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6">
      <header className="flex items-center justify-between">
        <p className="font-mono text-sm font-semibold text-emerald-600 dark:text-emerald-400">phishwatch</p>
        <UserButton />
      </header>

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {watches === null ? (
        <p className="text-sm text-zinc-500" role="status">Loading your brands…</p>
      ) : (
        <WatchesPanel watches={watches} presets={presets} add={add} remove={remove} />
      )}
    </div>
  );
}

"use client";

import { UserButton, useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useRef, useState } from "react";
import { computeStatus } from "@/lib/status.ts";
import { useFeed } from "@/lib/useFeed.ts";
import { useNotifications } from "@/lib/useNotifications.ts";
import { useNow } from "@/lib/useNow.ts";
import { useSupabase } from "@/lib/supabase.ts";
import { useWatches } from "@/lib/useWatches.ts";
import type { Hit } from "@/lib/types.ts";
import { Feed } from "./Feed";
import { StatusBar } from "./StatusBar";
import { Toasts } from "./Toasts";
import { WatchesPanel } from "./WatchesPanel";

const HIGHLIGHT_MS = 10_000;

export function Dashboard() {
  const supabase = useSupabase();
  const { watches, presets, error: watchError, add, remove } = useWatches(supabase);
  const { userId } = useAuth();
  const notifications = useNotifications(userId);
  const [highlighted, setHighlighted] = useState<Set<number>>(new Set());

  // the live callback needs current watch names without resubscribing when they change
  const namesRef = useRef(new Map<string, string>());
  useEffect(() => {
    namesRef.current = new Map((watches ?? []).map((w) => [w.id, w.name]));
  }, [watches]);
  const { notify } = notifications;

  const onNewHit = useCallback((hit: Hit) => {
    notify(hit, namesRef.current.get(hit.watch_id) ?? "your brand");
    setHighlighted((s) => new Set(s).add(hit.id));
    setTimeout(() => setHighlighted((s) => {
      const next = new Set(s);
      next.delete(hit.id);
      return next;
    }), HIGHLIGHT_MS);
  }, [notify]);

  const feed = useFeed(supabase, watches, onNewHit);
  const now = useNow(1000);
  const status = computeStatus(feed.latestRun, feed.lastOkAt, now ?? 0, !feed.loaded || now === null);
  const error = watchError ?? feed.error;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6">
      <header className="flex items-center justify-between">
        <p className="font-mono text-sm font-semibold text-emerald-600 dark:text-emerald-400">phishwatch</p>
        <div className="flex items-center gap-3">
          {notifications.permission === "default" && (
            <button onClick={notifications.requestPermission} className="text-sm text-emerald-700 hover:underline dark:text-emerald-400">
              Notify me on this device
            </button>
          )}
          <UserButton />
        </div>
      </header>

      <StatusBar status={status} stats={feed.stats} connection={feed.connection} onResume={feed.resume} />

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {watches === null ? (
        <p className="text-sm text-zinc-500" role="status">Loading your brands…</p>
      ) : (
        <>
          <WatchesPanel watches={watches} presets={presets} add={add} remove={remove} />
          {watches.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
              Add your brand to start watching, or tap a preset above.
            </p>
          ) : feed.hits === null ? (
            <p className="text-sm text-zinc-500" role="status">Loading matches…</p>
          ) : (
            <Feed hits={feed.hits} watches={watches} now={now} highlighted={highlighted} unseenSince={notifications.unseenSince} />
          )}
        </>
      )}
      <Toasts toasts={notifications.toasts} dismiss={notifications.dismiss} />
    </div>
  );
}

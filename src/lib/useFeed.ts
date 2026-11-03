"use client";

// The live feed: an initial load, then two Realtime channels (INSERT only).
//   hits:  only rows for my watches (a server-side filter; RLS is the real guard)
//   runs:  every scanner run, for the freshness indicator
// The runs channel closes while the tab is hidden; both close after 20 minutes idle.
// Every (re)subscribe refetches, so nothing is missed while a channel was down.

import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";
import { HIT_COLUMNS, RUN_COLUMNS, type Hit, type Run, type ScanStats, type Watch } from "./types.ts";

const FEED_LIMIT = 100;
export const IDLE_AFTER_MS = 20 * 60 * 1000;
// 2 s, 4 s, 8 s, 16 s, then every 30 s: quick recovery from a one-off close, no hammering if it repeats
const rebuildDelay = (attempt: number) => Math.min(30_000, 2_000 * 2 ** attempt);

export type Connection = "connecting" | "live" | "reconnecting" | "paused";

export function useFeed(supabase: SupabaseClient | null, watches: Watch[] | null, onNewHit?: (hit: Hit) => void) {
  const [hits, setHits] = useState<Hit[] | null>(null); // null = loading
  const [latestRun, setLatestRun] = useState<Run | null>(null);
  const [lastOkAt, setLastOkAt] = useState<string | null>(null);
  const [stats, setStats] = useState<ScanStats | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hitsState, setHitsState] = useState<string>("idle");
  const [runsState, setRunsState] = useState<string>("idle");
  const [visible, setVisible] = useState(true);
  const [idle, setIdle] = useState(false);
  // bumped to rebuild a channel the server closed (e.g. "Token has expired")
  const [runsRetry, setRunsRetry] = useState(0);
  const [hitsRetry, setHitsRetry] = useState(0);

  const onNewHitRef = useRef(onNewHit);
  useEffect(() => {
    onNewHitRef.current = onNewHit;
  }, [onNewHit]);

  const watchesLoaded = watches !== null;
  const watchIds = (watches ?? []).map((w) => w.id).sort().join(",");

  // ---------------------------------------------------------------- initial load / refetch
  const refetch = useCallback(async () => {
    if (!supabase || !watchesLoaded) return;
    const [h, latest, lastOk, s] = await Promise.all([
      watchIds
        ? supabase.from("hits").select(HIT_COLUMNS).order("created_at", { ascending: false }).limit(FEED_LIMIT)
        : Promise.resolve({ data: [], error: null }),
      supabase.from("runs").select(RUN_COLUMNS).order("id", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("runs").select("ran_at").eq("ok", true).order("id", { ascending: false }).limit(1).maybeSingle(),
      supabase.rpc("scan_stats"),
    ]);
    const failed = h.error ?? latest.error ?? lastOk.error ?? s.error;
    if (failed) {
      setError(failed.message);
      return;
    }
    setError(null);
    setHits(h.data as Hit[]);
    setLatestRun((latest.data as Run | null) ?? null);
    setLastOkAt((lastOk.data as { ran_at: string } | null)?.ran_at ?? null);
    setStats(s.data as ScanStats);
    setLoaded(true);
  }, [supabase, watchIds, watchesLoaded]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading data from an external system
    void refetch();
  }, [refetch]);

  // ---------------------------------------------------------------- visibility and idle
  useEffect(() => {
    let idleTimer: ReturnType<typeof setTimeout>;
    const poke = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => setIdle(true), IDLE_AFTER_MS);
    };
    const onVisibility = () => {
      setVisible(!document.hidden);
      if (!document.hidden) poke();
    };
    const events = ["pointerdown", "keydown", "scroll", "pointermove"] as const;
    events.forEach((e) => window.addEventListener(e, poke, { passive: true }));
    document.addEventListener("visibilitychange", onVisibility);
    poke();
    return () => {
      clearTimeout(idleTimer);
      events.forEach((e) => window.removeEventListener(e, poke));
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const resume = useCallback(() => setIdle(false), []);

  // Channels reach refetch through a ref, so they don't resubscribe when it changes identity
  // (e.g. when the brand list finishes loading); they depend only on what they listen to.
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  // ---------------------------------------------------------------- runs channel (visible, not idle)
  const runsOpenedBefore = useRef(false);
  useEffect(() => {
    if (!supabase || !visible || idle) return;
    if (runsOpenedBefore.current) void refetchRef.current(); // back from hidden/idle/a rebuild: catch up first
    runsOpenedBefore.current = true;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const channel = track(
      supabase.channel(uniqueName("runs")).on("postgres_changes", { event: "INSERT", schema: "public", table: "runs" }, ({ new: row }) => {
        const run = row as Run;
        setLatestRun(run);
        if (run.ok) setLastOkAt(run.ran_at);
        setStats((s) => (s ? { ...s, scanned_today: s.scanned_today + run.scanned, runs_today: s.runs_today + 1 } : s));
      }),
      setRunsState,
      () => void refetchRef.current(),
      () => {
        if (!disposed) retry = setTimeout(() => setRunsRetry((n) => n + 1), rebuildDelay(runsRetry));
      },
    );
    return () => {
      disposed = true;
      clearTimeout(retry);
      setRunsState("idle");
      void supabase.removeChannel(channel);
    };
  }, [supabase, visible, idle, runsRetry]);

  // ---------------------------------------------------------------- hits channel (not idle; stays open when hidden, for notifications)
  useEffect(() => {
    if (!supabase || idle || !watchIds) return;
    if (hitsRetry > 0) void refetchRef.current(); // rebuilt after the server closed it: catch up
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const channel = track(
      supabase
        .channel(uniqueName("hits"))
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "hits", filter: `watch_id=in.(${watchIds})` },
          ({ new: row }) => {
            const hit = row as Hit;
            setHits((hs) => (hs && !hs.some((h) => h.id === hit.id) ? [hit, ...hs].slice(0, FEED_LIMIT) : hs));
            onNewHitRef.current?.(hit);
          },
        ),
      setHitsState,
      () => void refetchRef.current(),
      () => {
        if (!disposed) retry = setTimeout(() => setHitsRetry((n) => n + 1), rebuildDelay(hitsRetry));
      },
    );
    return () => {
      disposed = true;
      clearTimeout(retry);
      setHitsState("idle");
      void supabase.removeChannel(channel);
    };
  }, [supabase, idle, watchIds, hitsRetry]);

  // Hits of a removed watch disappear right away (the database cascade-deletes them too).
  const ids = new Set(watchIds.split(","));
  const visibleHits = hits?.filter((h) => ids.has(h.watch_id)) ?? null;

  const states = [runsState, watchIds ? hitsState : "SUBSCRIBED"].filter((s) => s !== "idle");
  const connection: Connection = idle
    ? "paused"
    : states.length > 0 && states.every((s) => s === "SUBSCRIBED")
      ? "live"
      : states.some((s) => s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED")
        ? "reconnecting"
        : "connecting";

  return { hits: visibleHits, latestRun, lastOkAt, stats, loaded, error, connection, resume };
}

// realtime-js reuses an existing channel with the same name, and removeChannel() takes a server
// round trip before the old one leaves the list. Asking for "runs" again in that window (a
// React re-mount, a rebuild, a visibility change) would hand back the dying channel, and nothing
// would listen. A postgres_changes channel's name is only a label (the table and filter are
// in its config), so each subscription gets its own.
function uniqueName(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

// Subscribe and report the channel's status. After an interruption that realtime-js recovers
// from by itself (it rejoins after errors and timeouts), onRecovered lets the caller refetch.
// A channel the *server* closed (e.g. "Token has expired") is never rejoined by realtime-js, so
// onLost asks the caller to rebuild it. The caller ignores onLost for its own cleanup.
function track(
  channel: RealtimeChannel,
  setState: (s: string) => void,
  onRecovered: () => void,
  onLost: () => void,
): RealtimeChannel {
  let interrupted = false;
  channel.subscribe((status) => {
    setState(status);
    if (status === "SUBSCRIBED" && interrupted) onRecovered();
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") interrupted = true;
    if (status === "CLOSED") onLost();
  });
  return channel;
}

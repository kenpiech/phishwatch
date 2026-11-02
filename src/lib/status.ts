// The page's freshness state, recomputed every second from the latest run.
// Freshness comes from runs, never from hits: zero hits is a normal result.

export const STALE_AFTER_S = 30; // 3 missed runs at one every 10 s

export interface RunLite {
  ran_at: string;
  ok: boolean;
  note: string | null;
  error: string | null;
  scanned: number;
}

export type Status =
  | { kind: "loading" }
  | { kind: "fresh"; ageS: number; run: RunLite }
  | { kind: "paused"; ageS: number } // kill switch on: runs arrive but say "disabled"
  | { kind: "stale"; ageS: number }
  | { kind: "down"; error: string; lastOkAgeS: number | null }
  | { kind: "empty" }; // no run has ever been recorded

export function computeStatus(
  latest: RunLite | null,
  lastOkAt: string | null,
  nowMs: number,
  loading: boolean,
): Status {
  if (loading) return { kind: "loading" };
  if (!latest) return { kind: "empty" };
  const ageS = Math.max(0, Math.round((nowMs - Date.parse(latest.ran_at)) / 1000));
  const lastOkAgeS = lastOkAt ? Math.max(0, Math.round((nowMs - Date.parse(lastOkAt)) / 1000)) : null;

  // down takes precedence while it's current; a very old failure is reported as stale instead
  if (!latest.ok && ageS <= STALE_AFTER_S) return { kind: "down", error: latest.error ?? "unknown error", lastOkAgeS };
  if (ageS > STALE_AFTER_S) return { kind: "stale", ageS };
  if (latest.note === "disabled") return { kind: "paused", ageS };
  return { kind: "fresh", ageS, run: latest };
}

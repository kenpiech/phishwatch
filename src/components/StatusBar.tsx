"use client";

import { compactNumber } from "@/lib/display.ts";
import type { Status } from "@/lib/status.ts";
import type { Connection } from "@/lib/useFeed.ts";
import type { ScanStats } from "@/lib/types.ts";

function ago(s: number): string {
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
}

export function StatusBar({ status, stats, connection, onResume }: {
  status: Status;
  stats: ScanStats | null;
  connection: Connection;
  onResume: () => void;
}) {
  if (connection === "paused") {
    return (
      <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-300 bg-zinc-50 px-4 py-3 text-sm dark:border-zinc-700 dark:bg-zinc-900">
        <span>Paused to save resources after 20 minutes without activity.</span>
        <button onClick={onResume} className="rounded-full bg-zinc-900 px-3 py-1 text-white dark:bg-zinc-100 dark:text-zinc-900">
          Resume
        </button>
      </div>
    );
  }

  const chip = connection === "reconnecting" && (
    <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">Reconnecting…</span>
  );
  const today = stats && (
    <span className="text-zinc-500">
      {compactNumber(stats.scanned_today)} certificates checked today · sampling ~12% of one Google CT log
    </span>
  );

  switch (status.kind) {
    case "loading":
      return (
        <Bar tone="grey" label="Connecting…" testId="status-loading">
          {chip}
        </Bar>
      );
    case "fresh":
      return (
        <Bar tone="green" label={`Live · scanned ${status.run.scanned} certificates · ${ago(status.ageS)}`} testId="status-fresh">
          {today}
          {chip}
        </Bar>
      );
    case "paused":
      return (
        <Bar tone="amber" label="Scanning is paused by the operator (kill switch)." testId="status-paused">
          {chip}
        </Bar>
      );
    case "stale":
      return (
        <Bar tone="amber" label={`No update for ${ago(status.ageS).replace(" ago", "")}. The scanner may be paused; matches shown may be out of date.`} testId="status-stale">
          {chip}
        </Bar>
      );
    case "down":
      return (
        <Bar
          tone="red"
          label={`Scanner error: ${status.error}${status.lastOkAgeS !== null ? ` · last success ${ago(status.lastOkAgeS)}` : ""}`}
          testId="status-down"
        >
          {chip}
        </Bar>
      );
    case "empty":
      return <Bar tone="grey" label="The scanner hasn't run yet." testId="status-empty" />;
  }
}

const TONES = {
  grey: "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300",
  green: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  amber: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
  red: "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
};
const DOTS = { grey: "bg-zinc-400", green: "bg-emerald-500 animate-pulse", amber: "bg-amber-500", red: "bg-red-500" };

function Bar({ tone, label, testId, children }: { tone: keyof typeof TONES; label: string; testId: string; children?: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite" data-testid={testId} className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-3 text-sm ${TONES[tone]}`}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${DOTS[tone]}`} aria-hidden />
      <span className="font-medium">{label}</span>
      {children}
    </div>
  );
}

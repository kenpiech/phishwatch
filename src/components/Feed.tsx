"use client";

import { useState } from "react";
import { defang, investigateLinks, reasonLabel, timeAgo } from "@/lib/display.ts";
import type { Hit, Severity, Watch } from "@/lib/types.ts";

const SEVERITY: Record<Severity, { label: string; badge: string; edge: string }> = {
  likely: { label: "Likely phishing", badge: "bg-red-600 text-white", edge: "border-l-red-600" },
  suspicious: { label: "Suspicious", badge: "bg-amber-500 text-black", edge: "border-l-amber-500" },
  low: { label: "Low", badge: "bg-zinc-300 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200", edge: "border-l-zinc-300 dark:border-l-zinc-700" },
};

export function Feed({ hits, watches, now, highlighted, unseenSince }: {
  hits: Hit[];
  watches: Watch[];
  now: number | null;
  highlighted: Set<number>; // arrived live in the last 10 s
  unseenSince: string | null; // last visit on this device: newer hits get a "New" tag
}) {
  const [showLow, setShowLow] = useState(false);
  const names = new Map(watches.map((w) => [w.id, w.name]));
  const shown = showLow ? hits : hits.filter((h) => h.severity !== "low");
  const lowCount = hits.length - hits.filter((h) => h.severity !== "low").length;

  return (
    <section aria-labelledby="feed-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="feed-heading" className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Lookalike domains</h2>
        {lowCount > 0 && (
          <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <input type="checkbox" checked={showLow} onChange={(e) => setShowLow(e.target.checked)} />
            Show low-risk matches ({lowCount})
          </label>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700" data-testid="feed-empty">
          {hits.length === 0
            ? `Watching ${watches.map((w) => w.name).join(", ")}. No lookalikes yet. That's good news.`
            : "Only low-risk matches so far."}
        </p>
      ) : (
        <ul className="space-y-2" data-testid="feed">
          {shown.map((h) => (
            <HitRow
              key={h.id}
              hit={h}
              watchName={names.get(h.watch_id) ?? "?"}
              now={now}
              highlight={highlighted.has(h.id)}
              isNew={unseenSince !== null && h.created_at > unseenSince}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function HitRow({ hit, watchName, now, highlight, isNew }: { hit: Hit; watchName: string; now: number | null; highlight: boolean; isNew: boolean }) {
  const sev = SEVERITY[hit.severity];
  return (
    <li
      data-testid="hit"
      className={`rounded-lg border border-l-4 border-zinc-200 p-3 transition-colors duration-1000 dark:border-zinc-800 ${sev.edge} ${
        highlight ? "bg-yellow-50 dark:bg-yellow-950" : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${sev.badge}`}>{sev.label}</span>
        {/* plain text, never a link: the domain may be a live phishing site */}
        <span className="break-all font-mono text-sm font-medium" data-testid="hit-domain">{defang(hit.domain)}</span>
        {isNew && <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-xs font-semibold text-white">New</span>}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {hit.reasons.map((r) => (
          <span key={r} className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            {reasonLabel(r)}
          </span>
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
        <span>{watchName}</span>
        <span>score {hit.score}</span>
        <span>{hit.issuer ?? "unknown issuer"} · {hit.entry_type === 1 ? "precertificate" : "certificate"}</span>
        <span title={hit.entry_ts}>{now ? timeAgo(Date.parse(hit.entry_ts), now) : ""}</span>
        {hit.seen_count > 1 && <span>seen {hit.seen_count}×</span>}
        <span className="flex gap-2">
          {investigateLinks(hit.domain).map((l) => (
            <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer nofollow" className="text-emerald-700 hover:underline dark:text-emerald-400">
              {l.label} ↗
            </a>
          ))}
        </span>
      </div>
    </li>
  );
}

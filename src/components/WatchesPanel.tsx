"use client";

import { useState } from "react";
import { MAX_WATCHES, normalizeDomain, splitList, suggestTerm, type WatchInput } from "@/lib/display.ts";
import type { Preset, Watch } from "@/lib/types.ts";

interface Props {
  watches: Watch[];
  presets: Preset[];
  add: (w: WatchInput) => Promise<string | null>;
  remove: (id: string) => Promise<string | null>;
}

export function WatchesPanel({ watches, presets, add, remove }: Props) {
  const [open, setOpen] = useState(watches.length === 0);
  const [error, setError] = useState<string | null>(null);
  const atLimit = watches.length >= MAX_WATCHES;
  const watchedNames = new Set(watches.map((w) => w.name.toLowerCase()));

  async function run(action: () => Promise<string | null>) {
    setError(null);
    const err = await action();
    if (err) setError(err);
    return err;
  }

  return (
    <section aria-labelledby="watches-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="watches-heading" className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Your brands <span className="font-normal normal-case">({watches.length}/{MAX_WATCHES})</span>
        </h2>
        {!atLimit && (
          <button onClick={() => setOpen((o) => !o)} className="text-sm text-emerald-700 hover:underline dark:text-emerald-400">
            {open ? "Close" : "+ Add a brand"}
          </button>
        )}
      </div>

      {watches.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {watches.map((w) => (
            <li key={w.id} className="flex items-center gap-2 rounded-full border border-zinc-200 py-1 pl-3 pr-1 text-sm dark:border-zinc-800">
              <span className="font-medium">{w.name}</span>
              <span className="font-mono text-xs text-zinc-500">{w.terms.join(", ")}</span>
              <button
                onClick={() => confirm(`Stop watching ${w.name}? Its matches are deleted too.`) && run(() => remove(w.id))}
                className="rounded-full px-2 text-zinc-400 hover:bg-zinc-100 hover:text-red-600 dark:hover:bg-zinc-800"
                aria-label={`Stop watching ${w.name}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {open && !atLimit && (
        <div className="space-y-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <WatchForm onSubmit={async (w) => (await run(() => add(w))) === null && setOpen(false)} />
          {presets.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-zinc-500">Or try a commonly impersonated brand:</p>
              <div className="flex flex-wrap gap-2">
                {presets.map((p) => {
                  const added = watchedNames.has(p.name.toLowerCase());
                  return (
                    <button
                      key={p.id}
                      disabled={added}
                      onClick={() => run(() => add({ name: p.name, official_domains: p.official_domains, terms: p.terms }))}
                      className="rounded-full border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    >
                      {added ? `✓ ${p.name}` : `+ ${p.name}`}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function WatchForm({ onSubmit }: { onSubmit: (w: WatchInput) => Promise<unknown> }) {
  const [name, setName] = useState("");
  const [domains, setDomains] = useState("");
  const [terms, setTerms] = useState("");
  const [termsEdited, setTermsEdited] = useState(false);
  const [busy, setBusy] = useState(false);

  function onDomains(value: string) {
    setDomains(value);
    if (!termsEdited) setTerms(suggestTerm(splitList(value)[0] ?? "")); // acmecu.org -> acmecu
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    await onSubmit({ name, official_domains: splitList(domains).map(normalizeDomain), terms: splitList(terms) });
    setBusy(false);
  }

  const field = "w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700";
  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-3">
      <label className="space-y-1 text-sm">
        <span className="text-zinc-600 dark:text-zinc-400">Brand name</span>
        <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Credit Union" maxLength={60} required />
      </label>
      <label className="space-y-1 text-sm">
        <span className="text-zinc-600 dark:text-zinc-400">Official domains (1–3)</span>
        <input className={field} value={domains} onChange={(e) => onDomains(e.target.value)} placeholder="acmecu.org" required />
      </label>
      <label className="space-y-1 text-sm">
        <span className="text-zinc-600 dark:text-zinc-400">Terms to look for (1–5)</span>
        <input
          className={`${field} font-mono`}
          value={terms}
          onChange={(e) => {
            setTerms(e.target.value);
            setTermsEdited(true);
          }}
          placeholder="acmecu"
          required
        />
      </label>
      <p className="text-xs text-zinc-500 sm:col-span-2">
        Separate several with commas. Your official domains and their subdomains are never flagged.
      </p>
      <button
        type="submit"
        disabled={busy}
        className="justify-self-end rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
      >
        {busy ? "Adding…" : "Start watching"}
      </button>
    </form>
  );
}

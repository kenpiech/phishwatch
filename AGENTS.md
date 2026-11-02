<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# phishwatch

phishwatch watches newly issued HTTPS certificates for domains that impersonate a brand. Each signed-in person registers their own brand (a "watch": a name, official domains, terms) or adds a preset. A worker flags lookalike domains as they appear in Certificate Transparency logs, and the page shows them live.

It is a standalone app. It shares no code, database, Clerk app or Vercel project with any other app in the parent folder.

## Architecture

- **Source:** Google's static-CT (tiled) log ParcelYard 2027h1, `https://storage.googleapis.com/parcelyard2027h1.prod.certificate.transparency.goog/`. `GET /checkpoint` returns the tree size on line 2. `GET /tile/data/<path>` returns 256 binary entries (~384 KB, immutable). Tile N's path splits N into 3-digit groups, with `x` on all but the last (1986692 → `x001/x986/692`). It is free and needs no key.
- **Worker:** the Supabase Edge Function `scan` (Deno, `supabase/functions/scan/`), called by Supabase Cron every 10 s. It reads the newest full tile, parses the SAN domains, scores them against every watch, inserts only new `hits` (`on conflict do nothing`) and writes one `runs` row per run. It writes with the Supabase secret key, which Supabase provides at runtime.
- **Database:** Supabase Postgres with tables `presets`, `watches`, `hits`, `runs` and `scan_state`. RLS uses `auth.jwt()->>'sub'` (the Clerk user id, through Supabase third-party auth).
- **Page:** Next.js (App Router) + Tailwind on Vercel, with Clerk for sign-in. Realtime `postgres_changes` (INSERT only) on `hits` and `runs`.

## Rules

- Secrets never go in code, commits or chat. `.env*` is gitignored and Read/Edit-denied. The Supabase secret key lives only in Supabase (function env and Vault).
- No payment method is added to any service (Supabase Free, Vercel Hobby, Clerk Free). If a service asks for one, stop and ask.
- Domains from the log may be live phishing sites. Show them defanged (`example[.]top`) and never render them as links.
- `supabase/` is excluded in `tsconfig.json`, because Edge Functions are Deno, not Node.
- Tests for the worker: `npx deno test` inside `supabase/functions/scan/`.

## Kill switch

- Pause scanning: `update scan_state set enabled = false;` (each run exits early and logs `note='disabled'`)
- Stop the schedule: `select cron.unschedule('scan-every-10s');`

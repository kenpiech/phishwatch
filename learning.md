# Learning log

The "Ask Your Agent" answer for each build step.

## Step 1: Choose the live source

**Ask:** "Explain this response: what each field means, how often it changes, and which fields my app needs."

The source is Google's static-CT log **ParcelYard 2027h1**. It has two endpoints, and both were fetched live on 2026-11-02.

### `GET /checkpoint`: how big the log is right now

```
parcelyard2027h1.prod.certificate.transparency.goog      ← origin
574689662                                                ← tree size
E4JM4XvZrAIx7T7rvc0VR159unyp0zyHin28gi2ST3g=             ← root hash
                                                         ← blank line
— parcelyard2027h1.prod… DjOtSwAAAaGc…                   ← log signatures (2)
— witness.navigli.sunlight.geomys.org o+AP4g…            ← witness co-signatures (2)
— witness.stagemole.eu Z/euoAAAAABq…
```

| Field | Meaning | How often it changes | Needed? |
|---|---|---|---|
| Origin | The log's name. It tells you which log this checkpoint is for. | Never | No. It could serve as a sanity check if `log_url` is ever misconfigured. |
| **Tree size** | How many entries the log holds. Entries are numbered from 0, so the newest is `size − 1`. | About every second. It grew **+45,121 in 194 s (≈233/s)**, about 20 M/day. | **Yes, it's the only field we use.** `floor(size / 256)` is the number of full tiles, so the newest full tile is that number minus 1. |
| Root hash | The Merkle tree root over all entries. It commits the log to its exact contents, so it can't rewrite history without being caught. | With every tree size | No. Proof checking is listed under Later. |
| Signature lines | The log signs the note. Independent **witnesses** co-sign it to show they saw the same tree, which makes it hard for the log to show different people different logs. | With every checkpoint | No. Signature verification is listed under Later. |

The response is `Cache-Control: no-cache`, so every fetch is fresh.

### `GET /tile/data/<path>`: the certificates themselves

Tile N holds entries `256·N … 256·N + 255`. At size 574,689,662 the newest full tile is **2244880**, path `x002/x244/880`. It's saved as `supabase/functions/scan/fixtures/real-tile.bin`.

- **Size:** 345,970 bytes, binary.
- **Caching:** `immutable`. A full tile never changes once written, so a new one appears roughly every 256 / 233 ≈ **1.1 s**.
- **Contents:** 256 entries, **172 certificates and 84 precertificates**. They are contiguous (leaf 574,689,280 to 574,689,535), and the parser consumes every byte.
- **Time span:** 16:00:42.060 to 16:00:43.159 UTC, about 1.1 s of issuance. It was fetched at about 16:00:45, so it was only **~2–3 s behind** real time. On 10-29 we measured ~15 s, so lag varies.

Each entry, with the fields phishwatch needs in **bold**:

| Field | Meaning | Needed? |
|---|---|---|
| **timestamp** (u64, ms) | When the log accepted the cert | **Yes**, stored as `hits.entry_ts` ("seen at") |
| **entry_type** (u16) | 0 = final certificate, 1 = precertificate (logged *before* issuance, the earliest warning) | **Yes**, to choose the parse path |
| issuer key hash (32 B, precert only) | Hash of the issuing CA's key | No (skip) |
| **cert / TBSCertificate** (u24 len + DER) | The certificate body. Its Subject Alternative Name extension lists the domains, and its Issuer names the CA. | **Yes**: SAN domains are what we score, and the issuer is shown in the UI. |
| **extensions** (u16 len) | Holds `leaf_index`, the entry's position in the log, e.g. `0x0022411000` = 574,689,280 | **Yes**, stored as `hits.log_index` so a hit can be traced to its exact entry |
| pre-certificate (u24 len, precert only) | The full signed precert | No (skip) |
| chain fingerprints (u16 len, 32 B each) | Hashes of the CA chain, which can be fetched from `/issuer/` | No (skip) |

### What this means for the worker

- Each run needs **1 checkpoint + 1 tile** (≈350 KB).
- About 9 new tiles appear per 10 s run, and reading the newest one samples **≈11%** of this log. Each run records `scanned` and `skipped` honestly.
- Each entry is length-prefixed, and the parser must skip every field it doesn't use. Any miscount desyncs the rest of the tile. The test asserts exactly 256 entries and that every byte is consumed.

## Step 2: Agent access

**Ask:** "List the MCP servers and CLIs you can use in this project, and what you'd use each one for. Then check that each one works."

Checked live on 2026-11-02.

### MCP servers

| Server | What I'd use it for | Check | Result |
|---|---|---|---|
| **Supabase MCP** (`.mcp.json`, scoped to project `wralmcqegvbfjixjkhve` only) | Migrations (tables, RLS, Realtime publication), running SQL to inspect `runs`/`hits`, deploying the `scan` Edge Function, reading function and Postgres logs, security advisors | `get_project_url`, `list_tables`, `list_edge_functions`, `list_extensions`, `query_logs`, `execute_sql` | ✅ URL `wralmcqegvbfjixjkhve.supabase.co`; 0 tables, 0 functions (clean project); logs from 7 sources; SQL runs as `postgres` on PostgreSQL 17.11; Vault installed (0 secrets); `pg_cron` and `pg_net` available, to be enabled in Step 4e |

Other MCP servers are connected to my session (artifacts, Claude Docs, Gmail/Calendar/Drive), but phishwatch doesn't use them.

### CLIs

| CLI | What I'd use it for | Check | Result |
|---|---|---|---|
| **Deno** (`npx deno`, devDependency) | Running the worker's tests (`deno test`) with the same runtime as Edge Functions | `deno --version`, ran a script | ✅ 2.9.6 |
| **Clerk** (`npx clerk`) | Inspecting the Clerk app, creating the two Playwright test users | `clerk whoami` | ✅ 4.1.0, linked to app **phishwatch** (development instance; no production instance, which is fine) |
| **Vercel** | Linking, env var names, deploy status, production URL | `vercel whoami`, `vercel project inspect`, `vercel env ls`, `vercel ls` | ✅ 62.1.0, project `phishwatch` (Hobby) linked; exactly 4 env vars; first deploy Ready at **https://phishwatch-umber.vercel.app** (200) |
| **GitHub** (`gh`, `git`) | Pushing commits, which triggers Vercel deploys | `gh auth status`, `gh repo view` | ✅ `kenpiech/phishwatch` (public) is `origin` |
| **openssl** | Generating real certificates with chosen SANs for the synthetic-tile test (Step 4b) | `openssl version`; decoded a cert from the real tile in Step 1 | ✅ 3.3.2 |
| **curl** | Fetching the checkpoint and tiles by hand | Used in Step 1 | ✅ |
| **Supabase CLI** (`npx supabase`, devDependency) | Only `supabase init` (done). The MCP does migrations and deploys. | `supabase --version`, `supabase projects list` | ⚠️ 3.0.0 installed but **not logged in**. Not needed unless the MCP falls short. |
| **Playwright** | The two-user RLS and Realtime test (Step 5) | `npx playwright --version` | ⏳ not installed yet; added in Step 5 |

### What I can't check from here
- **Clerk ↔ Supabase third-party auth.** It's a dashboard setting the MCP can't see. The Step 5 Playwright test proves it: user A's JWT must pass RLS and user B must see nothing of A's.
- **Secrets.** By design I can't read `.env*` and don't hold the Supabase secret key. The Edge Function gets it from Supabase at runtime.

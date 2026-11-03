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

## Step 3: Data-flow chart

**Ask:** "Walk me through the chart: what each part sends to the next, and what would break if one part changed it."

The chart is in `README.md`. It has seven arrows, taken in the order data moves.

### 1. Cron → `scan`: "run now"
- **Sends:** every 10 s, `pg_cron` runs a SQL job that uses `pg_net` to make an **HTTP POST** to the function's URL. The request carries an `Authorization` header with a key read from **Vault**. The body is empty. The trigger carries no data; it only says "go".
- **If it changes:** if the function URL, its name or the Vault key is wrong, the POST gets a 404 or 401. The function never runs, so **no `runs` row** is written. Nothing logs an error in our tables, and the page shows **stale** after 30 s. The failed call shows up only in `net._http_response` and `cron.job_run_details`.

### 2. `scan` → `/checkpoint`: "how big is the log?"
- **Sends:** one `GET`. It **receives** about 600 bytes of signed text, and the worker keeps only **line 2, the tree size**. `floor(size / 256) − 1` gives the newest full tile.
- **If it changes:** after a shard rollover or rename, the request returns 404. The worker writes `runs.ok = false` with the error, and the page shows **down**. If line 2 stops being a number, the worker rejects it the same way rather than guessing. A 429 or 5xx response makes the worker back off (`scan_state.backoff_until`).

### 3. `scan` → `/tile/data/…`: "give me those 256 certificates"
- **Sends:** one `GET` for the tile path (`x002/x244/880`). It **receives** about 350 KB of binary: 256 length-prefixed entries, each with a timestamp, entry type, certificate DER, leaf index and fields we skip.
- **If it changes:** a new path scheme returns 404, which means **down**. A changed entry layout makes the parser throw, or end with a byte count that isn't exactly 256 entries. The worker refuses to save partial results, writes `ok = false` with the error, and the page shows **down**. If the certificate format changed, we'd just extract no domains: the run is ok, with 0 hits, which is the hardest failure to notice. `runs.scanned` (domain count) dropping to 0 is the warning sign.

### 4. `scan` → Postgres: "here's what's new"
- **Reads first:** `scan_state` (`enabled`, `log_url`, cursor, backoff) and all `watches`.
- **Sends:**
  - `insert into hits … on conflict (watch_id, domain) do nothing`: `watch_id, domain, registrable, score, severity, reasons[], issuer, entry_ts, log_index`
  - one `runs` row: `ok, error, note, scanned, skipped, hits_inserted, tree_size, tile_from, tile_to` and timings
  - an update to the `scan_state` cursor

  It writes with the **secret key**, which bypasses RLS. That's why clients get no write access to these tables.
- **If it changes:**
  - If a column is renamed or a constraint added, the hits insert fails, and the error goes into `runs`, so the page shows **down**.
  - If the **`runs` insert itself** breaks, the worker can't log anything, so the page shows **stale**.
  - If the **unique key** is dropped, every rerun re-inserts the same hits, and users get duplicate alerts every 10 s. That's why "a second run inserts 0 rows" is a test.

### 5. Postgres → Realtime: "a row was inserted"
- **Sends:** each committed insert into a table in the **`supabase_realtime` publication** (`hits`, `runs`) goes out through Postgres's write-ahead log (WAL) as an INSERT event with the full new row.
- **If it changes:** if a table is removed from the publication, Realtime never hears about inserts. There's **no error anywhere**; the page silently gets nothing. For `runs` this shows as **stale**. For `hits` it looks like "no matches", which is why the page's freshness comes from `runs`.

### 6. Realtime → page: "this row is yours"
- **Sends:** over one **WebSocket**, a `postgres_changes` message with the new row's JSON. Before sending, Realtime checks RLS **as that subscriber**: it needs `grant select` on the table **and** a select policy that passes. So user A gets only hits on A's watches, and everyone gets `runs`.
- **If it changes:** if the grant or policy is dropped, the message is silently filtered out (the spec's warning). If the page subscribes to UPDATE or DELETE, it gets nothing useful, because Realtime can't apply RLS to deletes. That's why it subscribes to INSERT only. A dropped connection triggers a reconnect and a refetch, and the page shows a connection state.

### 7. Page ↔ Postgres: "who I am, and what I want"
- **Sends:** the browser gets a **Clerk session token** (a JWT with `sub = user_…` and `role = authenticated`) and sends it as a Bearer token to Supabase's REST API. Supabase verifies it through **third-party auth**, and RLS compares `auth.jwt()->>'sub'` to `watches.user_id`. The page uses it to load watches, the last hits and the latest run, and to create, update and delete watches. The same token authorizes the Realtime socket (arrow 6).
- **If it changes:**
  - If **third-party auth is disabled**, or the Clerk **`role` claim is removed**, the request is treated as anonymous, and RLS returns nothing: an empty page, no error.
  - If the **`sub` format changes**, for example after moving to a new Clerk app, existing watches no longer match, and a user "loses" their brands.
  - The Playwright test with two users catches both.

### What ties it together
Only **`runs`** shows whether the system is working, and every failure ends in one of two visible states:
- **down:** a run completed but reported an error (`ok = false`)
- **stale:** no run arrived. Covers cron, auth, publication or socket failures.

The page judges freshness by the age of the last `runs` row, never by whether hits are arriving, because zero hits is a normal result.

## Step 4: Build the worker

**Ask:** "Show me the worker's logs from its last three runs, and explain each line."

These are the Supabase function logs (`function_logs`) and gateway logs (`function_edge_logs`) for three consecutive cron runs on 2026-11-02, oldest first. Each run writes four JSON lines, one per phase, which is enough to explain a run without exceeding Edge logging limits.

### Run A: 17:15:44 UTC

```
17:15:44.966  {"phase":"checkpoint","tree_size":575664793,"newest_tile":2248689,"next_tile":2248683,"skipped":6}
17:15:46.070  {"phase":"tiles","tiles":[2248689],"bytes":384579,"fetch_ms":1237}
17:15:46.133  {"phase":"score","scanned":256,"domains":326,"watches":5,"hits":0,"unreadable":0,"parse_ms":28}
17:15:46.156  {"phase":"write","inserted":0,"updated":0,"next_tile":2248690,"duration_ms":1339}
17:15:46.157  POST | 200 | …/functions/v1/scan   (1,539 ms)
```

| Line | Meaning |
|---|---|
| `checkpoint` | The log holds **575,664,793** entries, so the newest *full* tile is ⌊575,664,793 / 256⌋ − 1 = **2248689**. The cursor (`next_tile`) says the last run ended before **2248683**, so tiles 2248683–2248688 (**6**) were issued since then and won't be read: we sample the newest one. |
| `tiles` | Downloaded tile **2248689**: **384,579 bytes** (256 entries). Fetching the checkpoint plus the tile from Google took **1,237 ms**, most of the run. |
| `score` | All **256** entries parsed, none unreadable. They named **326** unique domains after cleanup. Each was scored against the **5** watches (the hidden demo brands): **0** hits. That took **28 ms** of CPU, about 1.4% of the 2-second limit. |
| `write` | `finish_scan` upserted nothing (**0 inserted, 0 updated**), wrote the `runs` row and moved the cursor to **2248690**. The run took **1,339 ms** from claim to write. |
| `POST \| 200` | The gateway's view: cron's request was accepted (secret key OK) and answered **200** in **1,539 ms**. That's ~200 ms more than `duration_ms`, which covers the key check and the response. |

### Run B: 17:15:54 UTC

```
17:15:54.975  {"phase":"checkpoint","tree_size":575666455,"newest_tile":2248696,"next_tile":2248690,"skipped":6}
17:15:55.669  {"phase":"tiles","tiles":[2248696],"bytes":370589,"fetch_ms":833}
17:15:55.718  {"phase":"score","scanned":256,"domains":302,"watches":5,"hits":0,"unreadable":0,"parse_ms":26}
17:15:55.756  {"phase":"write","inserted":0,"updated":0,"next_tile":2248697,"duration_ms":934}
17:15:55.758  POST | 200 | …/functions/v1/scan   (1,125 ms)
17:15:59.803  shutdown
```

- **`checkpoint`:** `next_tile` **2248690** is exactly what Run A wrote: the cursor carries from run to run. The log grew by **1,662** entries in ~10 s (≈166/s, quieter than the 233/s measured in Step 1), so 6 tiles were skipped again.
- **`tiles`, `score`, `write`:** same story. A different tile (2248696), a slightly smaller tile (370,589 bytes, since entries vary in length), 302 domains, 0 hits, cursor → 2248697.
- **`shutdown`:** the Edge runtime stopped this function's worker (an isolate) ~4 s after it answered. Supabase keeps a worker warm between nearby calls, then recycles it. This is normal, not an error.

### Run C: 17:16:05 UTC

```
17:16:05.086  booted (time: 60ms)
17:16:05.956  {"phase":"checkpoint","tree_size":575668191,"newest_tile":2248702,"next_tile":2248697,"skipped":5}
17:16:06.015  {"phase":"tiles","tiles":[2248702],"bytes":381166,"fetch_ms":761}
17:16:06.094  {"phase":"score","scanned":256,"domains":338,"watches":5,"hits":0,"unreadable":0,"parse_ms":46}
17:16:06.137  {"phase":"write","inserted":0,"updated":0,"next_tile":2248703,"duration_ms":952}
17:16:06.139  POST | 200 | …/functions/v1/scan   (1,237 ms)
```

- **`booted (time: 60ms)`:** because Run B's worker shut down, this run started a fresh one (a cold start), which took 60 ms. The gap between `booted` and `checkpoint` (~0.9 s) is loading the imports and the claim RPC.
- **`checkpoint` … `write`:** cursor 2248697 → 2248703. **5** tiles skipped this time, because a little less was issued in this interval. 338 domains, 0 hits, 46 ms of CPU.

### What the three runs show together
- **Freshness:** a run every ~10 s (44.97 → 54.98 → 05.96), each one `ok`. These are the `runs` rows the page will use for "fresh".
- **The cursor chain** 2248683 → 2248690 → 2248697 → 2248703 never goes backwards and never re-reads a tile.
- **Coverage:** we read 1 tile and skip 5–6, so ≈15% of the log in this quieter minute (≈11–12% at busier times).
- **Where time goes:** downloading from Google (~0.8–1.2 s) dominates, while parsing and scoring stays at 26–46 ms. The CPU budget has room for `tiles_per_run = 3` if we ever want more coverage.
- **0 hits is normal:** about 1 second of issuance per run, and the demo brands appear a few times a minute *across the whole log*. The first two scheduled minutes produced 2 low-severity hits (Heroku hostnames containing "apple").

## Step 5: Make the page live

**Ask:** "Trace one update for me, from the source to my screen, and name every part it passes through."

*Answer written by the agent overnight (2026-11-03), from the production database, to read before the live quiz.*

A real update: match **#892** for the Microsoft demo brand, `www.www.login.microsoftonline-billing-verification-secured-help.109-206-162-145.plesk[.]page`, **likely**, score 10. Times are UTC, 2026-11-03.

| # | Part | What happens | Evidence |
|---|---|---|---|
| 1 | **Let's Encrypt** (a CA) | Someone who controls that name asks for a certificate. Before issuing it, the CA must publish it in CT logs, because browsers reject unlogged certificates. | `issuer = Let's Encrypt`, `entry_type = 0` (a final certificate) |
| 2 | **Google's CT log** ParcelYard 2027h1 | Appends it as entry **582,780,574** at **03:01:28.467**. That entry sits in tile ⌊582,780,574 / 256⌋ = **2276486**, which becomes a full, immutable 256-entry file once its last entry lands. | `log_index`, `entry_ts` |
| 3 | **Supabase Cron** (`pg_cron`, job `scan-every-10s`) | At ~03:01:29.9 runs its SQL: `net.http_post` (`pg_net`) to `/functions/v1/scan`, with the project URL and the secret key read from **Vault** at call time. | `cron.job` |
| 4 | **Edge Functions gateway → `withSupabase({ auth: "secret" })`** | Checks the `apikey` header against the project's secret keys (a stranger gets 401), then hands the handler an admin client. | `index.ts` |
| 5 | **`claim_scan()`** (Postgres RPC) | Checks the kill switch, backoff and lease, and takes a 60 s lease so runs can't overlap. Returns the cursor. | `worker_rpcs` migration |
| 6 | **Google again** (2 HTTP GETs) | `/checkpoint` reports a tree size of **582,780,815**, so the newest full tile is **2276486**. **7** newer-than-cursor tiles are skipped (sampling). `GET /tile/data/x002/x276/486` downloads 256 entries. Both took **1,228 ms**. | run 3527: `tree_size`, `tile_from`, `skipped`, `fetch_ms` |
| 7 | **`tile.ts` → `x509.ts` → `score.ts`** (inside the function) | Splits the tile into 256 entries, reads each certificate's SAN names (**296** unique domains after cleanup), and scores each against every brand. This one: `microsoftonline` is "microsoft" glued to "online", the brand is in a subdomain of someone else's domain (`….plesk.page`), it has bait words *billing* and *login*, and 7 hyphens, giving 2+3+4+1 = **10, likely**. All of this took **18 ms** of CPU. | run 3527: `domains`, `parse_ms`; hit `reasons` |
| 8 | **`finish_scan()`** (one Postgres transaction) | Upserts the hit (new `(watch, domain)` → **insert**), writes `runs` row **3527** (`hits_inserted = 1`), moves the cursor to 2276487 and releases the lease. Commits at **03:01:31.190**: **2.7 s** after Google logged the certificate. | hit `created_at` = run `ran_at` (same transaction) |
| 9 | **Postgres WAL → Realtime** | The committed insert is in the write-ahead log. `hits` is in the `supabase_realtime` publication, so Supabase Realtime reads the change from its replication slot. | `alter publication supabase_realtime add table hits, runs` |
| 10 | **Realtime's authorization, per subscriber** | Open pages subscribed to `hits` with a filter `watch_id=in.(their watch ids)` are candidates. For each one, Realtime runs the `hits` select policy **as that subscriber**, using the Clerk token their socket last presented: "is this hit's watch yours?". That needs all three things the spec lists: the table in the publication, `grant select` to `authenticated`, and the policy. | `schema` migration |
| 11 | **The WebSocket → supabase-js** | Only the owner's socket receives a `postgres_changes` frame with the new row as JSON. | frame logs during Step 5 testing |
| 12 | **`useFeed` → React** | The channel callback prepends the row to the feed state and calls `onNewHit`, which highlights it for 10 s, raises a toast ("New likely-phishing domain for Microsoft"), adds `(1)` to the tab title if the tab is hidden, and sends a system notification if you opted in. | `useFeed.ts`, `useNotifications.ts` |
| 13 | **`Feed` → the screen** | Renders the row: red "Likely phishing" badge, the domain **defanged** (`…plesk[.]page`, plain text, never a link), the reasons in words ("brand inside “microsoftonline”", "brand as a subdomain", "bait word: billing" …), Let's Encrypt, "certificate", "N s ago", and urlscan/VirusTotal lookups. | `Feed.tsx` |

In parallel, `runs` row 3527 takes the same path from step 9 on, on the `runs` channel (every signed-in user may read runs). The status bar sets "Live · scanned 256 certificates · 0 s ago" and adds 256 to today's total.

**An honest footnote:** #892 belongs to a hidden demo brand owned by a placeholder user nobody can sign in as, so at step 10 Realtime found **no** authorized subscriber and no screen received it. That's RLS working as intended. Steps 10–13 for a real person are what the Playwright two-user test proves: a match created for A's brand appears on A's open page without a reload, with a toast, and never on B's.

**Keeping the socket authorized:** Clerk tokens live about 60 s. supabase-js asks our `accessToken` callback (Clerk's `getToken()`) for the current token on each 25 s heartbeat, and the page also asks every 10 s (see below). When the token has changed, it sends an `access_token` frame on every channel, and the server re-checks and replies "Subscribed to PostgreSQL".

### What testing found: three Realtime bugs, fixed overnight

The two-user test passed on its first real run. A test that keeps the page open for minutes did not: after about 2.5 minutes, live updates stopped and the page sat on "Reconnecting…". Recording every WebSocket frame (Playwright `page.on("websocket")`) traced it to three separate bugs.

1. **Token rotation race.** realtime-js re-reads the token only on its 25 s heartbeat, but Clerk sometimes mints the next 60 s token only ~18 s before the old one expires. The recording showed a token pushed at 103.5 s expiring at 151.6 s, with Clerk's replacement arriving at ~134 s: between heartbeats. At 151.6 s the server sent `"Token has expired 0 seconds ago"` and closed both channels (`phx_close`).
   **Fix:** the page offers Clerk's current token every 10 s (`realtime.setAuth()`); a frame goes out only when the token actually changed.
2. **Closed channels are never rejoined.** realtime-js rejoins after errors and timeouts, but not after the *server* closes a channel. The page waited forever.
   **Fix:** on a close we didn't cause, rebuild the channel after 2 s (backing off to 30 s if it keeps happening) and refetch what was missed.
3. **A new channel could be the dying old one.** realtime-js reuses an existing channel with the same name, and removing one takes a server round trip. Asking for `"runs"` again in that window (a React re-mount, the rebuild in fix 2) handed back the channel that was shutting down. Separately, our sign-out cleanup (`removeAllChannels()`) disconnected the socket *after* a re-mounted component had queued its join. Together these broke Realtime completely for a user with **zero brands**, which is every new user. With brands, a later subscription happened to reconnect the socket and hid the bug.
   **Fix:** every subscription gets a unique channel name (`runs-<uuid>`), and each channel's owner removes its own.

**Proof:**
- the 3.5-minute test (at least three token rotations) now passes
- a new recovery test feeds the page's socket the exact two frames from the recorded failure and checks that the page rejoins and is live again within ~10 s
- with the rebuild code disabled, that test fails, so it really tests the fix

## Step 6: Deploy & test

### Ask 1: "Quiz me on how my system works, one question at a time, and tell me what I got wrong. Start with the questions in Be Ready to Explain."

*The live quiz needs you, so this is the study guide the agent quizzes from: the four "Be Ready to Explain" questions, then follow-ups, each with a model answer from the real system. Cover the answers and try each question first.*

**1. Tracing a data change: when the data source changes, what happens in the worker, in the database, and on someone's screen?**
> The source changing means a CA publishing a certificate into Google's CT log, which grows by roughly 200 entries a second. Within 10 s, Supabase Cron POSTs to the `scan` Edge Function with the secret key from Vault. The worker reads `/checkpoint` (tree size), computes the newest full tile, downloads it (256 entries), reads each certificate's SAN domains, and scores each domain against every brand. In the **database**, `finish_scan` upserts only what changed in one transaction: new `(watch, domain)` pairs are inserted, a newer sighting updates `last_seen_at`/`seen_count`, a repeat does nothing. It also adds one `runs` row and moves the cursor. Postgres sends the inserts to **Realtime**, which checks RLS for each subscriber and pushes the hit only to its owner's open page, where it slides in highlighted, with a toast. Real example: match #892 was logged at 03:01:28.467 and saved at 03:01:31.190, 2.7 s later (see Step 5).

**2. The data flow: how data moves from the source to the page, and what would break if one part changed.**
> CT log → (HTTP GET) → Edge Function → (RPC upsert) → Postgres → (WAL) → Realtime → (WebSocket) → page. The page also reads Postgres directly for the initial load, with the Clerk JWT. What breaks:
> - a log shard rename → 404 → `runs.ok = false` → page **down** (fix `scan_state.log_url`)
> - a tile format change → the parser throws → **down** with the error
> - the cron stops → no runs → **stale** after 30 s
> - the table removed from the publication, or the grant or policy dropped → the page silently gets nothing → **stale** (for runs) or an empty feed
> - a Clerk/Supabase auth change → RLS denies → empty page, caught by the two-user test
>
> The chart is in the README.

**3. Freshness: how someone knows the data is current.**
> The status bar, recomputed every second from the latest `runs` row, never from hits (zero hits is normal):
> - **Live** · "scanned 256 certificates · 4 s ago" while the last run is ok and ≤ 30 s old
> - **No update for 2 min** (stale) when > 30 s (three missed runs)
> - **Scanner error: …** (down) when the latest run failed, with the last success time
> - **Paused** when the kill switch is on
> - a **Reconnecting…** chip, kept separate from freshness, when the WebSocket drops
>
> Today's total ("2.1 M certificates checked today") comes from `scan_stats()`.

**4. Agentic workflow: what your agent's tests check, and what you found in the logs.**
> - **Worker** (`deno test`, 55 tests):
>   - the real saved tile parses to exactly 256 entries, with every byte consumed
>   - its 172 certificates' SAN names match openssl's
>   - certificates generated with openssl yield exactly 7 expected hits and scores
>   - the end-to-end run saves exactly the expected rows
>   - a rerun saves 0, a newer sighting updates 1
>   - failures keep the cursor; 429 backs off; the kill switch makes no requests
>
>   Tests were also checked by breaking the code on purpose (they fail).
> - **Page** (`npm test`): status rules, defanging, validation.
> - **Playwright:**
>   - the signed-out page
>   - add/remove a brand
>   - A vs B isolation in the page and through the API
>   - a live match without a reload
>   - B can't plant a match on A's brand
>   - a 3.5-minute session across token rotations
>   - recovery after the server closes a channel
> - **Logs:**
>   - four phases per run (checkpoint → tiles → score → write)
>   - downloading dominates (≈1 s); scoring takes 20–50 ms
>   - the cursor chain never re-reads a tile
>   - one checkpoint timeout in 3,500 runs, which led to clearer timeout errors
>   - live hits exposed scorer noise (`bsicloud`, `ccloud`/`hcloud`, Heroku hostnames), fixed with tests
>   - WebSocket frame recordings caught three Realtime bugs (token rotation race, closed channels never rejoined, dying channels reused), all fixed with tests

**Follow-ups worth rehearsing**
- *Why upsert and not a plain insert?* So reruns can't duplicate rows or Realtime alerts. The unique key plus `on conflict … do update … where newer` makes every run idempotent.
- *Why does the worker use the secret key, and where is it?* The worker isn't a user, and it must write `hits`/`runs`, which clients can't. The key is in the function's environment (provided by Supabase) and in Vault for cron; never in git or on Vercel.
- *Why INSERT-only subscriptions?* Pruning deletes rows, and Realtime can't apply RLS to DELETE events; we don't need updates on screen.
- *Why sample 1 tile in ~9?* One free Edge Function call every 10 s fits the quotas; reading everything needs an always-on streaming worker.
- *How is a classmate kept out of your data?* Every table has RLS keyed on the Clerk `sub`; the hits policy joins to the owner's watches; the two-user test proves it in the browser and through the API.
- *Why are domains defanged?* They may be live phishing sites; `[.]` stops autolinking, and we only link to urlscan/VirusTotal lookups.

### Ask 2: "Walk me through the free tier limits for each service my app uses, and how to set usage limits and spending alerts for each one."

*Limits checked on the providers' pricing pages on 2026-11-03; usage measured from the database the same night (the first 10 hours: 3,536 runs, 2 failures, 19 MB database).*

**The ground rule:** no service has a payment method on file, so nothing can be charged. At a limit, the worst case is a paused or restricted service. If any service ever asks for a card, stop and ask first.

| Service | Free limit | phishwatch's use | At the limit |
|---|---|---|---|
| **Supabase** (Free) | 500 k Edge Function calls/month | cron every 10 s ≈ 8,640/day ≈ **268 k (54%)** | Supabase emails the owner and may restrict the project until the cycle resets. No overage billing on Free; spend caps are a Pro feature. |
| | 2 M Realtime messages/month · 200 concurrent connections | 1 `runs` message per run **per open tab** (360 per tab-hour); hits are rare. The runs channel closes in hidden tabs; both close after 20 idle minutes. | |
| | 500 MB database · 5 GB egress | 19 MB after 10 h; `prune-daily` keeps runs to 2 days and cron history to 1 day; small JSON payloads | |
| | pauses after 1 week without use · 2 active projects | the cron counts as activity, but open the app now and then until grades are back | |
| **Vercel** (Hobby) | 1 M function invocations, 100 GB Fast Data Transfer, 4 h active CPU per month | the page is a static shell; data goes browser → Supabase directly, so Vercel serves almost nothing | the feature pauses until 30 days have passed. Hobby has no spend management, because nothing can be billed. Non-commercial use only. |
| **Clerk** (Hobby/Free) | 50,000 monthly retained users per app; email codes included; no card | a class's worth of users | a one-month grace period to upgrade. phishwatch runs on a **development instance** (the console warns of stricter usage limits), fine for a demo; real use would need a production instance on a custom domain. |
| **Google CT log** | no account, no published quota | 1 checkpoint + 1 tile (~370 KB) per run ≈ 3 GB/day; `User-Agent` names the repo; immutable tiles cache well | backoff on 429/5xx (5 min) |

**Where to watch usage and set alerts:**
- **Supabase:** Dashboard → Organization → **Usage** shows each quota above as a bar for the billing cycle. Free plans get email notices as limits approach. phishwatch's own safeguards:
  - **Kill switch:** `update scan_state set enabled = false;`
  - **Full stop:** `select cron.unschedule('scan-every-10s');`
  - **Health query:** in the README
- **Vercel:** Dashboard → team **Usage**: per-resource meters for the month. Spend Management (alerts and hard limits) is Pro-only; on Hobby the limit itself is the cap.
- **Clerk:** Dashboard → the app → **Billing/Usage** shows retained users. No card means no overage.
- **Google:** nothing to configure. Be polite, and the worker backs off by itself.

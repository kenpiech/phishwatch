// End to end: the real worker (runScan) on saved tiles, with a fake network that serves
// the fixtures and a fake database that applies the same rules as the SQL functions
// claim_scan / finish_scan (those were checked against real Postgres in step 4a).
// Each test asserts exactly what the worker would save.

import { assertEquals, assertMatch } from "@std/assert";
import { type Claim, type Db, type Deps, type HitRow, type RunRow, runScan, tilePath } from "./worker.ts";
import type { Watch } from "./score.ts";
import { ACME, buildTile, fixture, META, REAL_TILE_INDEX, syntheticTile } from "./testing.ts";

const LOG = "https://ct.example/log/";

// ---------------------------------------------------------------- fakes

interface State {
  enabled: boolean;
  tiles_per_run: number;
  next_tile: number | null;
  backoff: boolean;
  consecutive_failures: number;
}

type StoredHit = HitRow & { last_seen_at: string; seen_count: number };

class FakeDb implements Db {
  state: State = { enabled: true, tiles_per_run: 1, next_tile: null, backoff: false, consecutive_failures: 0 };
  hits = new Map<string, StoredHit>(); // key: watch_id + " " + domain (the unique key)
  runs: (RunRow & { hits_inserted: number; hits_updated: number })[] = [];
  constructor(public watchList: Watch[]) {}

  claim(): Promise<Claim> {
    if (!this.state.enabled) return Promise.resolve({ status: "disabled" });
    if (this.state.backoff) return Promise.resolve({ status: "backoff" });
    const { tiles_per_run, next_tile } = this.state;
    return Promise.resolve({ status: "ok", log_url: LOG, tiles_per_run, next_tile });
  }

  watches() {
    return Promise.resolve(this.watchList);
  }

  finish(run: RunRow, hits: HitRow[], nextTile: number | null, backoff: boolean) {
    let inserted = 0, updated = 0;
    if (run.ok) {
      for (const h of hits) {
        const key = `${h.watch_id} ${h.domain}`;
        const old = this.hits.get(key);
        if (!old) {
          this.hits.set(key, { ...h, last_seen_at: h.entry_ts, seen_count: 1 });
          inserted++;
        } else if (old.last_seen_at < h.entry_ts) { // only a newer sighting is a change
          old.last_seen_at = h.entry_ts;
          old.seen_count++;
          updated++;
        }
      }
      if (nextTile !== null) this.state.next_tile = nextTile;
      this.state.consecutive_failures = 0;
    } else {
      this.state.consecutive_failures++;
      if (backoff || this.state.consecutive_failures >= 5) this.state.backoff = true;
    }
    this.runs.push({ ...run, hits_inserted: inserted, hits_updated: updated });
    return Promise.resolve({ inserted, updated });
  }
}

// A fake CT log: a checkpoint with the given tree size, and tiles by number.
function fakeLog(treeSize: number | string, tiles: Record<number, Uint8Array>, status: Record<string, number> = {}) {
  const requests: { url: string; userAgent: string | null }[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, userAgent: new Headers(init?.headers).get("user-agent") });
    const path = url.slice(LOG.length);
    if (status[path]) return Promise.resolve(new Response("nope", { status: status[path] }));
    if (path === "checkpoint") {
      return Promise.resolve(new Response(`ct.example/log\n${treeSize}\nROOTHASH=\n\n— ct.example sig\n`));
    }
    for (const [n, bytes] of Object.entries(tiles)) {
      if (path === `tile/data/${tilePath(Number(n))}`) return Promise.resolve(new Response(new Uint8Array(bytes)));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

const quiet = () => {};
let clock = 0;
const deps = (db: Db, log: ReturnType<typeof fakeLog>, extra: Partial<Deps> = {}): Deps => ({
  db, fetch: log.fetch, log: quiet, now: () => (clock += 5), ...extra,
});

// Checkpoint size that makes tile N the newest full tile (plus a partial tile in progress).
const sizeFor = (newestFullTile: number) => (newestFullTile + 1) * 256 + 100;

// ---------------------------------------------------------------- the real tile

Deno.test("real tile: one checkpoint + one tile, 256 entries scanned, no preset hits, cursor advanced", async () => {
  const db = new FakeDb([ACME, META]);
  const log = fakeLog(sizeFor(REAL_TILE_INDEX), { [REAL_TILE_INDEX]: fixture("real-tile.bin") });

  const result = await runScan(deps(db, log));

  assertEquals(log.requests.map((r) => r.url), [LOG + "checkpoint", LOG + "tile/data/x002/x244/880"]);
  assertEquals(log.requests.every((r) => r.userAgent?.startsWith("phishwatch/")), true);
  assertEquals(result.status, "ok");
  assertEquals(db.hits.size, 0);
  assertEquals(db.runs.length, 1);
  const run = db.runs[0];
  assertEquals(
    { ok: run.ok, scanned: run.scanned, domains: run.domains, skipped: run.skipped, tree_size: run.tree_size, tile_from: run.tile_from, tile_to: run.tile_to, hits_inserted: run.hits_inserted, note: run.note },
    { ok: true, scanned: 256, domains: 398, skipped: 0, tree_size: sizeFor(REAL_TILE_INDEX), tile_from: REAL_TILE_INDEX, tile_to: REAL_TILE_INDEX, hits_inserted: 0, note: undefined },
  );
  assertEquals(db.state.next_tile, REAL_TILE_INDEX + 1);
});

// ---------------------------------------------------------------- the synthetic tile: what gets saved

const SYN = 7; // the synthetic tile is served as tile 7
const issuer = "Phishwatch Test CA";
const at = (ms: number) => new Date(Date.UTC(2026, 10, 2, 16, 0, 0) + ms).toISOString();
// entry 0 = cert a (leaf 1792), entry 1 = cert b as a precertificate (1793), entry 2 = cert c (1794)
const a = { entry_type: 0, entry_ts: at(0), log_index: SYN * 256 + 0, issuer } as const;
const b = { entry_type: 1, entry_ts: at(1), log_index: SYN * 256 + 1, issuer } as const;
const c = { entry_type: 0, entry_ts: at(2), log_index: SYN * 256 + 2, issuer } as const;

const EXPECTED_HITS: HitRow[] = [
  { watch_id: "w-acme", domain: "acmecu-login.top", registrable: "acmecu-login.top", score: 6, severity: "suspicious", reasons: ["term:acmecu", "bait:login", "tld:top"], ...a },
  { watch_id: "w-acme", domain: "acmecu-pay.xyz", registrable: "acmecu-pay.xyz", score: 4, severity: "suspicious", reasons: ["term:acmecu", "tld:xyz"], ...c },
  { watch_id: "w-acme", domain: "acmecu-secure-login-verify.top", registrable: "acmecu-secure-login-verify.top", score: 9, severity: "likely", reasons: ["term:acmecu", "bait:login", "bait:secure", "tld:top", "hyphens:3"], ...c },
  { watch_id: "w-acme", domain: "acmecu.org.verify-acct.top", registrable: "verify-acct.top", score: 9, severity: "likely", reasons: ["term:acmecu", "subdomain", "bait:verify", "tld:top"], ...b },
  { watch_id: "w-acme", domain: "acrnecu.com", registrable: "acrnecu.com", score: 5, severity: "suspicious", reasons: ["term:acmecu", "lookalike:acrnecu"], ...b },
  { watch_id: "w-acme", domain: "myacmecu.net", registrable: "myacmecu.net", score: 2, severity: "low", reasons: ["glued:myacmecu"], ...c },
  { watch_id: "w-acme", domain: "xn--cmecu-3ve.com", registrable: "xn--cmecu-3ve.com", score: 5, severity: "suspicious", reasons: ["term:acmecu", "lookalike:аcmecu"], ...c },
];

const savedHits = (db: FakeDb) =>
  [...db.hits.values()].map(({ last_seen_at: _l, seen_count: _s, ...h }) => h).sort((x, y) => (x.domain < y.domain ? -1 : 1));

Deno.test("synthetic tile: saves exactly the 7 expected hits, one runs row, and moves the cursor", async () => {
  const db = new FakeDb([ACME, META]);
  const log = fakeLog(sizeFor(SYN), { [SYN]: syntheticTile(SYN) });

  const result = await runScan(deps(db, log));

  assertEquals(result.status, "ok");
  assertEquals(savedHits(db), EXPECTED_HITS);
  assertEquals(db.runs.length, 1);
  const run = db.runs[0];
  // 256 entries; domains: a(3) + b(3) + c(4, AWS noise dropped) + filler d(2) = 12 unique
  assertEquals([run.ok, run.scanned, run.domains, run.hits_inserted, run.hits_updated], [true, 256, 12, 7, 0]);
  assertEquals(db.state.next_tile, SYN + 1);
});

Deno.test("second run, nothing new in the log: reads only the checkpoint, saves 0 rows", async () => {
  const db = new FakeDb([ACME, META]);
  const log = fakeLog(sizeFor(SYN), { [SYN]: syntheticTile(SYN) });
  await runScan(deps(db, log));
  log.requests.length = 0;

  await runScan(deps(db, log));

  assertEquals(log.requests.map((r) => r.url), [LOG + "checkpoint"]);
  assertEquals(db.runs[1].note, "no new tile");
  assertEquals([db.runs[1].ok, db.runs[1].hits_inserted, db.runs[1].hits_updated], [true, 0, 0]);
  assertEquals(db.hits.size, 7);
});

Deno.test("re-reading the same tile changes nothing (the upsert is idempotent)", async () => {
  const db = new FakeDb([ACME, META]);
  const log = fakeLog(sizeFor(SYN), { [SYN]: syntheticTile(SYN) });
  await runScan(deps(db, log));
  db.state.next_tile = SYN; // force the worker to read tile 7 again

  await runScan(deps(db, log));

  assertEquals([db.runs[1].hits_inserted, db.runs[1].hits_updated], [0, 0]);
  assertEquals(savedHits(db), EXPECTED_HITS);
});

Deno.test("a newer certificate for a known domain updates it instead of adding a row", async () => {
  const db = new FakeDb([ACME, META]);
  const log = fakeLog(sizeFor(SYN + 1), {
    [SYN]: syntheticTile(SYN),
    // tile 8 re-issues certificate a (acmecu-login.top) an hour later
    [SYN + 1]: buildTile(SYN + 1, [{ certDer: fixture("synthetic/a.der") }], fixture("synthetic/d.der"), Date.UTC(2026, 10, 2, 17)),
  });
  db.state.next_tile = SYN;
  db.state.tiles_per_run = 2;

  await runScan(deps(db, log)); // reads tiles 7 and 8 together: first sighting wins within a run
  assertEquals([db.runs[0].hits_inserted, db.runs[0].hits_updated], [7, 0]);

  db.state.next_tile = SYN + 1;
  db.state.tiles_per_run = 1;
  await runScan(deps(db, log)); // tile 8 alone: a newer sighting of acmecu-login.top

  assertEquals([db.runs[1].hits_inserted, db.runs[1].hits_updated], [0, 1]);
  const h = db.hits.get("w-acme acmecu-login.top")!;
  assertEquals([h.seen_count, h.last_seen_at, h.entry_ts], [2, at(3_600_000), at(0)]);
});

// ---------------------------------------------------------------- sampling and the flood guard

Deno.test("sampling: when behind, reads only the newest tile and counts the skipped ones", async () => {
  const db = new FakeDb([ACME]);
  const log = fakeLog(sizeFor(10), { 10: syntheticTile(10) });
  db.state.next_tile = 3;

  await runScan(deps(db, log));

  assertEquals(log.requests.map((r) => r.url), [LOG + "checkpoint", LOG + "tile/data/010"]);
  assertEquals([db.runs[0].skipped, db.runs[0].tile_from, db.runs[0].tile_to], [7, 10, 10]);
  assertEquals(db.state.next_tile, 11);
});

Deno.test("flood guard: keeps only each watch's top-scoring hits", async () => {
  const db = new FakeDb([ACME]);
  const log = fakeLog(sizeFor(SYN), { [SYN]: syntheticTile(SYN) });

  await runScan(deps(db, log, { maxHitsPerWatch: 2 }));

  assertEquals([...db.hits.keys()].sort(), ["w-acme acmecu-secure-login-verify.top", "w-acme acmecu.org.verify-acct.top"]);
});

// ---------------------------------------------------------------- failures: logged, cursor kept

Deno.test("checkpoint 404 (log shard renamed): run fails with the error, cursor unchanged, no backoff yet", async () => {
  const db = new FakeDb([ACME]);
  db.state.next_tile = 5;
  const log = fakeLog(0, {}, { checkpoint: 404 });

  const result = await runScan(deps(db, log));

  assertEquals(result.status, "error");
  assertEquals(db.runs[0].ok, false);
  assertMatch(db.runs[0].error!, /checkpoint -> HTTP 404/);
  assertEquals([db.state.next_tile, db.state.consecutive_failures, db.state.backoff], [5, 1, false]);
});

Deno.test("HTTP 429 from the log: backs off immediately", async () => {
  const db = new FakeDb([ACME]);
  await runScan(deps(db, fakeLog(0, {}, { checkpoint: 429 })));
  assertEquals(db.state.backoff, true);
});

Deno.test("five failures in a row: backs off", async () => {
  const db = new FakeDb([ACME]);
  for (let i = 0; i < 5; i++) await runScan(deps(db, fakeLog(0, {}, { checkpoint: 404 })));
  assertEquals([db.state.consecutive_failures, db.state.backoff], [5, true]);
});

Deno.test("a malformed tile fails the run loudly and saves no hits", async () => {
  const db = new FakeDb([ACME]);
  const tile = syntheticTile(SYN);
  const log = fakeLog(sizeFor(SYN), { [SYN]: tile.subarray(0, tile.length - 10) });

  await runScan(deps(db, log));

  assertEquals(db.runs[0].ok, false);
  assertMatch(db.runs[0].error!, /truncated/);
  assertEquals(db.hits.size, 0);
  assertEquals(db.state.next_tile, null);
});

Deno.test("a checkpoint without a number on line 2 is rejected", async () => {
  const db = new FakeDb([ACME]);
  await runScan(deps(db, fakeLog("<html>oops</html>", {})));
  assertMatch(db.runs[0].error!, /not a tree size/);
});

// ---------------------------------------------------------------- refusals: no network at all

Deno.test("kill switch: a disabled scan makes no requests", async () => {
  const db = new FakeDb([ACME]);
  db.state.enabled = false;
  const log = fakeLog(sizeFor(SYN), { [SYN]: syntheticTile(SYN) });

  const result = await runScan(deps(db, log));

  assertEquals(result, { status: "disabled" });
  assertEquals(log.requests.length, 0);
});

// ---------------------------------------------------------------- paths

Deno.test("tile paths split the number into 3-digit groups", () => {
  assertEquals(tilePath(2244880), "x002/x244/880");
  assertEquals(tilePath(1986692), "x001/x986/692");
  assertEquals(tilePath(7), "007");
  assertEquals(tilePath(1000), "x001/000");
});

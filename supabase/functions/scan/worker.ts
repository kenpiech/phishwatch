// One scan run: checkpoint -> newest full tile(s) -> domains -> scores -> save.
// All I/O comes in through `deps`, so tests can run the real logic on saved tiles
// with a fake network and a fake database.

import { ENTRIES_PER_TILE, parseTile } from "./tile.ts";
import { parseCert } from "./x509.ts";
import { analyzeDomain, cleanDomain, scoreDomain, type Severity, type Watch } from "./score.ts";

export const MAX_HITS_PER_WATCH_PER_RUN = 20; // flood guard
const CHECKPOINT_TIMEOUT_MS = 5_000;
const TILE_TIMEOUT_MS = 10_000;
const USER_AGENT = "phishwatch/0.1 (+https://github.com/kenpiech/phishwatch)";

// ------------------------------------------------------------------ the database, as the worker sees it

export type Claim =
  | { status: "ok"; log_url: string; tiles_per_run: number; next_tile: number | null }
  | { status: "disabled" | "backoff" | "busy" };

export interface RunRow {
  ok: boolean;
  note?: string;
  error?: string;
  scanned?: number; // log entries parsed
  domains?: number; // unique domains scored
  skipped?: number; // full tiles not read (sampling)
  tree_size?: number;
  tile_from?: number;
  tile_to?: number;
  fetch_ms?: number;
  parse_ms?: number;
  duration_ms?: number;
}

export interface HitRow {
  watch_id: string;
  domain: string;
  registrable: string | null;
  score: number;
  severity: Severity;
  reasons: string[];
  issuer: string | null;
  entry_type: 0 | 1;
  entry_ts: string; // ISO
  log_index: number;
}

export interface Db {
  claim(): Promise<Claim>; // claim_scan(): kill switch, backoff, lease
  watches(): Promise<Watch[]>;
  finish(run: RunRow, hits: HitRow[], nextTile: number | null, backoff: boolean): Promise<{ inserted: number; updated: number }>;
}

export interface Deps {
  db: Db;
  fetch: typeof fetch;
  log?: (line: Record<string, unknown>) => void;
  now?: () => number;
  maxHitsPerWatch?: number; // defaults to MAX_HITS_PER_WATCH_PER_RUN
}

export type RunResult =
  | { status: "disabled" | "backoff" | "busy" }
  | { status: "ok"; run: RunRow; inserted: number; updated: number; hits: number }
  | { status: "error"; run: RunRow };

// ------------------------------------------------------------------ helpers

// Tile N's path: N split into 3-digit groups, "x" on all but the last. 2244880 -> x002/x244/880
export function tilePath(n: number): string {
  const groups: string[] = [];
  do {
    groups.unshift(String(n % 1000).padStart(3, "0"));
    n = Math.floor(n / 1000);
  } while (n > 0);
  return groups.map((g, i) => (i < groups.length - 1 ? "x" + g : g)).join("/");
}

class HttpError extends Error {
  constructor(readonly url: string, readonly status: number) {
    super(`GET ${url} -> HTTP ${status}`);
  }
  // Rate limiting or server trouble on Google's side: back off instead of retrying every 10 s.
  get backoff(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

async function get(deps: Deps, url: string, timeoutMs: number): Promise<Response> {
  const res = await deps.fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new HttpError(url, res.status);
  }
  return res;
}

export function parseCheckpoint(text: string): number {
  const size = text.split("\n")[1]?.trim() ?? "";
  if (!/^\d+$/.test(size)) throw new Error(`checkpoint line 2 is not a tree size: ${JSON.stringify(size.slice(0, 40))}`);
  return Number(size);
}

interface Seen {
  entryTs: number;
  logIndex: number;
  entryType: 0 | 1;
  issuer: string | null;
}

// ------------------------------------------------------------------ the run

export async function runScan(deps: Deps): Promise<RunResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line) => console.log(JSON.stringify(line)));
  const started = now();

  const claim = await deps.db.claim();
  if (claim.status !== "ok") {
    log({ phase: "claim", status: claim.status });
    return { status: claim.status };
  }

  const run: RunRow = { ok: true };
  try {
    // 1. how big is the log?
    const base = claim.log_url.endsWith("/") ? claim.log_url : claim.log_url + "/";
    const t0 = now();
    const treeSize = parseCheckpoint(await (await get(deps, base + "checkpoint", CHECKPOINT_TIMEOUT_MS)).text());
    const newest = Math.floor(treeSize / ENTRIES_PER_TILE) - 1;
    run.tree_size = treeSize;

    // 2. which tiles: the newest `tiles_per_run`, never re-reading tiles before the cursor
    const window = newest - claim.tiles_per_run + 1;
    const from = claim.next_tile === null ? window : Math.max(claim.next_tile, window);
    run.skipped = claim.next_tile === null ? 0 : Math.max(0, window - claim.next_tile);
    log({ phase: "checkpoint", tree_size: treeSize, newest_tile: newest, next_tile: claim.next_tile, skipped: run.skipped });

    if (from > newest) {
      run.note = "no new tile";
      run.duration_ms = now() - started;
      const r = await deps.db.finish(run, [], null, false);
      return { status: "ok", run, ...r, hits: 0 };
    }
    run.tile_from = from;
    run.tile_to = newest;

    const tileNumbers = Array.from({ length: newest - from + 1 }, (_, i) => from + i);
    const tiles = await Promise.all(
      tileNumbers.map(async (n) =>
        new Uint8Array(await (await get(deps, `${base}tile/data/${tilePath(n)}`, TILE_TIMEOUT_MS)).arrayBuffer())
      ),
    );
    run.fetch_ms = now() - t0;
    log({ phase: "tiles", tiles: tileNumbers, bytes: tiles.reduce((s, t) => s + t.length, 0), fetch_ms: run.fetch_ms });

    // 3. parse: every entry -> its domains (first sighting wins)
    const t1 = now();
    const seen = new Map<string, Seen>();
    let scanned = 0;
    let unreadable = 0;
    for (const tile of tiles) {
      for (const e of parseTile(tile)) { // a malformed tile throws: the run fails loudly
        scanned++;
        let cert;
        try {
          cert = parseCert(e.der, e.entryType === 1);
        } catch {
          unreadable++; // one odd certificate shouldn't sink the run; it's counted in the note
          continue;
        }
        for (const name of cert.dnsNames) {
          const domain = cleanDomain(name);
          if (domain && !seen.has(domain)) {
            seen.set(domain, { entryTs: e.timestamp, logIndex: e.leafIndex, entryType: e.entryType, issuer: cert.issuer });
          }
        }
      }
    }
    if (scanned > 0 && unreadable === scanned) throw new Error(`all ${scanned} certificates were unreadable`);
    run.scanned = scanned;
    run.domains = seen.size;
    if (unreadable) run.note = `${unreadable} unreadable certificate${unreadable === 1 ? "" : "s"}`;

    // 4. score every domain against every watch
    const watches = await deps.db.watches();
    const byWatch = new Map<string, HitRow[]>();
    for (const [domain, s] of seen) {
      const info = analyzeDomain(domain);
      for (const w of watches) {
        const score = scoreDomain(info, w);
        if (!score) continue;
        const list = byWatch.get(w.id) ?? [];
        list.push({
          watch_id: w.id,
          domain,
          registrable: info.registrable,
          score: score.score,
          severity: score.severity,
          reasons: score.reasons,
          issuer: s.issuer,
          entry_type: s.entryType,
          entry_ts: new Date(s.entryTs).toISOString(),
          log_index: s.logIndex,
        });
        byWatch.set(w.id, list);
      }
    }
    // flood guard: keep each watch's top 20 by score
    const cap = deps.maxHitsPerWatch ?? MAX_HITS_PER_WATCH_PER_RUN;
    const hits = [...byWatch.values()].flatMap((list) =>
      list.sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain)).slice(0, cap)
    );
    run.parse_ms = now() - t1;
    log({ phase: "score", scanned, domains: seen.size, watches: watches.length, hits: hits.length, unreadable, parse_ms: run.parse_ms });

    // 5. save: upsert hits, log the run, move the cursor past what we read
    run.duration_ms = now() - started;
    const r = await deps.db.finish(run, hits, newest + 1, false);
    log({ phase: "write", inserted: r.inserted, updated: r.updated, next_tile: newest + 1, duration_ms: run.duration_ms });
    return { status: "ok", run, ...r, hits: hits.length };
  } catch (err) {
    const failed: RunRow = { ...run, ok: false, error: err instanceof Error ? err.message : String(err), duration_ms: now() - started };
    const backoff = err instanceof HttpError && err.backoff;
    log({ phase: "error", error: failed.error, backoff });
    await deps.db.finish(failed, [], null, backoff);
    return { status: "error", run: failed };
  }
}

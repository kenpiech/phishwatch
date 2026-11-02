// Test helpers (not used by the worker): load fixtures and assemble tiles in the
// exact static-CT binary format, so tests can feed the parser known certificates.

import { ENTRIES_PER_TILE } from "./tile.ts";

const here = new URL(".", import.meta.url);

export function fixture(path: string): Uint8Array {
  return Deno.readFileSync(new URL(`fixtures/${path}`, here));
}

export const REAL_TILE_INDEX = 2244880; // fixtures/real-tile.bin, fetched 2026-11-02 16:00 UTC

export interface FakeEntry {
  certDer: Uint8Array; // a full certificate
  precert?: boolean; // log it as a precertificate (TBSCertificate only)
  timestamp?: number;
}

// The TBSCertificate is the first element inside the Certificate SEQUENCE.
export function tbsOf(certDer: Uint8Array): Uint8Array {
  const header = (off: number) => {
    let len = certDer[off + 1];
    let start = off + 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + certDer[start + i];
      start += n;
    }
    return { start, end: start + len };
  };
  const outer = header(0);
  return certDer.subarray(outer.start, header(outer.start).end);
}

function uint(n: number, bytes: number): number[] {
  const out = new Array(bytes);
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = n % 256;
    n = Math.floor(n / 256);
  }
  return out;
}

// One tile: the given entries first, then filler copies of `filler` up to 256.
export function buildTile(
  tileIndex: number,
  entries: FakeEntry[],
  filler: Uint8Array,
  baseTimestamp = Date.UTC(2026, 10, 2, 16, 0, 0),
): Uint8Array {
  const all = [...entries];
  while (all.length < ENTRIES_PER_TILE) all.push({ certDer: filler });

  const out: number[] = [];
  all.forEach((e, i) => {
    const leafIndex = tileIndex * ENTRIES_PER_TILE + i;
    out.push(...uint(e.timestamp ?? baseTimestamp + i, 8));
    if (e.precert) {
      const tbs = tbsOf(e.certDer);
      out.push(...uint(1, 2), ...new Array(32).fill(0xab), ...uint(tbs.length, 3), ...tbs);
    } else {
      out.push(...uint(0, 2), ...uint(e.certDer.length, 3), ...e.certDer);
    }
    out.push(...uint(8, 2), 0x00, ...uint(5, 2), ...uint(leafIndex, 5)); // leaf_index extension
    if (e.precert) out.push(...uint(e.certDer.length, 3), ...e.certDer); // pre-certificate
    out.push(...uint(32, 2), ...new Array(32).fill(0xcd)); // one chain fingerprint
  });
  return new Uint8Array(out);
}

// The synthetic tile used across tests: certificates a, b (as a precertificate) and c.
export function syntheticTile(tileIndex = 7): Uint8Array {
  return buildTile(
    tileIndex,
    [
      { certDer: fixture("synthetic/a.der") },
      { certDer: fixture("synthetic/b.der"), precert: true },
      { certDer: fixture("synthetic/c.der") },
    ],
    fixture("synthetic/d.der"),
  );
}

export const ACME = { id: "w-acme", official_domains: ["acmecu.org"], terms: ["acmecu"] };
export const META = { id: "w-meta", official_domains: ["meta.com"], terms: ["meta"] };

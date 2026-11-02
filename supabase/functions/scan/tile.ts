// Parse a static-CT data tile (C2SP static-ct-api) into its entries.
//
// Each entry (TLS presentation language, big-endian):
//   uint64  timestamp_ms
//   uint16  entry_type                  0 = x509 certificate, 1 = precertificate
//   if 0:   uint24 len + certificate DER
//   if 1:   32-byte issuer key hash + uint24 len + TBSCertificate DER
//   uint16  len + extensions            (holds leaf_index: type 0, 5-byte uint40)
//   if 1:   uint24 len + pre-certificate DER        (skipped)
//   uint16  len + chain fingerprints, 32 bytes each (skipped)
//
// Every field is length-prefixed, so one miscount would misread the rest of the tile.
// The parser therefore refuses anything that doesn't end exactly on an entry boundary.

export const ENTRIES_PER_TILE = 256;

export interface TileEntry {
  leafIndex: number; // position in the log
  timestamp: number; // ms since epoch, when the log accepted it
  entryType: 0 | 1; // 0 = certificate, 1 = precertificate
  der: Uint8Array; // type 0: full Certificate; type 1: TBSCertificate
}

export class TileFormatError extends Error {
  override name = "TileFormatError";
}

export function parseTile(bytes: Uint8Array, expected = ENTRIES_PER_TILE): TileEntry[] {
  const r = new Reader(bytes);
  const entries: TileEntry[] = [];

  while (!r.done()) {
    const at = r.pos;
    const timestamp = r.uint(8);
    const entryType = r.uint(2);
    if (entryType !== 0 && entryType !== 1) {
      throw new TileFormatError(`entry ${entries.length} at byte ${at}: unknown entry_type ${entryType}`);
    }

    if (entryType === 1) r.skip(32); // issuer key hash
    const der = r.bytes(r.uint(3));
    const extensions = r.bytes(r.uint(2));
    if (entryType === 1) r.skip(r.uint(3)); // pre-certificate
    r.skip(r.uint(2)); // chain fingerprints

    const leafIndex = readLeafIndex(extensions);
    if (leafIndex === null) {
      throw new TileFormatError(`entry ${entries.length} at byte ${at}: no leaf_index extension`);
    }
    entries.push({ leafIndex, timestamp, entryType, der });
  }

  if (entries.length !== expected) {
    throw new TileFormatError(`expected ${expected} entries, parsed ${entries.length}`);
  }
  return entries;
}

// CTExtensions: repeated { uint8 type, uint16 len, data }. leaf_index is type 0, a uint40.
function readLeafIndex(ext: Uint8Array): number | null {
  const r = new Reader(ext);
  while (!r.done()) {
    const type = r.uint(1);
    const data = r.bytes(r.uint(2));
    if (type === 0 && data.length === 5) return new Reader(data).uint(5);
  }
  return null;
}

class Reader {
  pos = 0;
  constructor(private buf: Uint8Array) {}

  done(): boolean {
    return this.pos >= this.buf.length;
  }

  private need(n: number) {
    if (this.pos + n > this.buf.length) {
      throw new TileFormatError(`truncated: need ${n} bytes at ${this.pos}, have ${this.buf.length - this.pos}`);
    }
  }

  // Big-endian unsigned int of n bytes (n <= 8; values stay below 2^53 in practice).
  uint(n: number): number {
    this.need(n);
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + this.buf[this.pos + i];
    this.pos += n;
    return v;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  skip(n: number) {
    this.need(n);
    this.pos += n;
  }
}

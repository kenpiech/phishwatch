import { assertEquals, assertThrows } from "@std/assert";
import { parseTile, TileFormatError } from "./tile.ts";
import { fixture, REAL_TILE_INDEX, syntheticTile } from "./testing.ts";

const real = fixture("real-tile.bin");

Deno.test("real tile: exactly 256 entries, every byte consumed", () => {
  const entries = parseTile(real);
  assertEquals(entries.length, 256);
});

Deno.test("real tile: leaf indexes are the 256 consecutive positions of tile 2244880", () => {
  const entries = parseTile(real);
  const first = REAL_TILE_INDEX * 256; // 574,689,280
  assertEquals(entries.map((e) => e.leafIndex), Array.from({ length: 256 }, (_, i) => first + i));
});

Deno.test("real tile: 172 certificates and 84 precertificates, logged within ~1 s", () => {
  const entries = parseTile(real);
  assertEquals(entries.filter((e) => e.entryType === 0).length, 172);
  assertEquals(entries.filter((e) => e.entryType === 1).length, 84);
  const ts = entries.map((e) => e.timestamp);
  assertEquals(new Date(Math.min(...ts)).toISOString(), "2026-11-02T16:00:42.060Z");
  assertEquals(new Date(Math.max(...ts)).toISOString(), "2026-11-02T16:00:43.159Z");
});

Deno.test("a truncated tile is rejected, not half-parsed", () => {
  assertThrows(() => parseTile(real.subarray(0, real.length - 1)), TileFormatError, "truncated");
});

Deno.test("trailing garbage is rejected", () => {
  const padded = new Uint8Array(real.length + 3);
  padded.set(real);
  assertThrows(() => parseTile(padded), TileFormatError);
});

Deno.test("the entry count is enforced", () => {
  assertThrows(() => parseTile(real, 255), TileFormatError, "expected 255 entries, parsed 256");
});

Deno.test("synthetic tile round-trips: types and indexes as built", () => {
  const entries = parseTile(syntheticTile(7));
  assertEquals(entries.length, 256);
  assertEquals(entries.slice(0, 3).map((e) => e.entryType), [0, 1, 0]);
  assertEquals(entries[0].leafIndex, 7 * 256);
  assertEquals(entries[255].leafIndex, 7 * 256 + 255);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStatus, type RunLite } from "./status.ts";

const now = Date.parse("2026-11-02T22:00:00Z");
const run = (agoS: number, extra: Partial<RunLite> = {}): RunLite => ({
  ran_at: new Date(now - agoS * 1000).toISOString(), ok: true, note: null, error: null, scanned: 256, ...extra,
});

test("loading while the first fetch is pending", () => {
  assert.equal(computeStatus(null, null, now, true).kind, "loading");
});

test("fresh: last run ok and at most 30 s old", () => {
  const s = computeStatus(run(4), null, now, false);
  assert.equal(s.kind, "fresh");
  assert.equal(s.kind === "fresh" && s.ageS, 4);
});

test("stale: no run for more than 30 s", () => {
  assert.deepEqual(computeStatus(run(31), null, now, false), { kind: "stale", ageS: 31 });
});

test("down: a current failed run wins, with the last success", () => {
  const s = computeStatus(run(5, { ok: false, error: "GET …/checkpoint -> HTTP 404" }), new Date(now - 180_000).toISOString(), now, false);
  assert.deepEqual(s, { kind: "down", error: "GET …/checkpoint -> HTTP 404", lastOkAgeS: 180 });
});

test("an old failure with nothing since reads as stale", () => {
  assert.equal(computeStatus(run(120, { ok: false, error: "x" }), null, now, false).kind, "stale");
});

test("paused: the kill switch is on", () => {
  assert.equal(computeStatus(run(3, { note: "disabled" }), null, now, false).kind, "paused");
});

test("empty: no run ever", () => {
  assert.equal(computeStatus(null, null, now, false).kind, "empty");
});

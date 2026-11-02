import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defang, investigateLinks, normalizeDomain, reasonLabel, splitList, suggestTerm, timeAgo, validateWatch,
} from "./display.ts";

test("defang breaks the last dot so the domain can't autolink", () => {
  assert.equal(defang("acmecu-login.top"), "acmecu-login[.]top");
  assert.equal(defang("a.b.verify-acct.top"), "a.b.verify-acct[.]top");
});

test("investigate links go to the lookup sites, never to the domain", () => {
  for (const { href } of investigateLinks("acmecu-login.top")) {
    assert.match(href, /^https:\/\/(urlscan\.io|www\.virustotal\.com)\//);
  }
});

test("reason tags read as words", () => {
  assert.deepEqual(
    ["term:acmecu", "lookalike:acrnecu", "subdomain", "bait:login", "tld:top", "hyphens:3"].map(reasonLabel),
    ["brand “acmecu”", "lookalike “acrnecu”", "brand as a subdomain", "bait word: login", "TLD .top", "3 hyphens"],
  );
});

test("timeAgo", () => {
  assert.equal(timeAgo(0, 4_000), "4 s ago");
  assert.equal(timeAgo(0, 125_000), "2 min ago");
  assert.equal(timeAgo(0, 3 * 3_600_000), "3 h ago");
});

test("form input: lists, pasted URLs, suggested term", () => {
  assert.deepEqual(splitList("acmecu.org, www.acmecu.org\nACMECU.org"), ["acmecu.org", "www.acmecu.org"]);
  assert.equal(normalizeDomain("https://www.AcmeCU.org/login?x=1"), "www.acmecu.org");
  assert.equal(suggestTerm("acmecu.org"), "acmecu");
  assert.equal(suggestTerm("https://www.acme-cu.co.uk/"), "acme-cu");
});

test("validateWatch mirrors the database checks", () => {
  const ok = { name: "Acme CU", official_domains: ["acmecu.org"], terms: ["acmecu"] };
  assert.equal(validateWatch(ok), null);
  assert.match(validateWatch({ ...ok, name: " " })!, /name/);
  assert.match(validateWatch({ ...ok, official_domains: ["not a domain"] })!, /isn't a domain/);
  assert.match(validateWatch({ ...ok, official_domains: ["a.com", "b.com", "c.com", "d.com"] })!, /1 to 3/);
  assert.match(validateWatch({ ...ok, terms: ["acm"] })!, /4–30/);
  assert.match(validateWatch({ ...ok, terms: ["login"] })!, /too generic/);
});

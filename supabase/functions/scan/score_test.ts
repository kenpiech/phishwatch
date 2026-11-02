import { assertEquals } from "@std/assert";
import { analyzeDomain, cleanDomain, editDistance, scoreDomain, skeleton, type Watch } from "./score.ts";
import { parseTile } from "./tile.ts";
import { parseCert } from "./x509.ts";
import { ACME, META, syntheticTile } from "./testing.ts";

const score = (domain: string, watch: Watch) => scoreDomain(analyzeDomain(domain), watch);

// ---------------------------------------------------------------- cleanup

Deno.test("cleanDomain: lowercase, strip wildcard and trailing dot", () => {
  assertEquals(cleanDomain("*.Example.COM."), "example.com");
  assertEquals(cleanDomain("www.acmecu.org"), "www.acmecu.org");
});

Deno.test("cleanDomain: drops non-hostnames", () => {
  assertEquals(cleanDomain("localhost"), null);
  assertEquals(cleanDomain("under_score.example.com"), null);
  assertEquals(cleanDomain("bad domain.com"), null);
});

Deno.test("cleanDomain: drops AWS and other infrastructure noise", () => {
  assertEquals(cleanDomain("acmecu.acm.aws.dev"), null);
  assertEquals(cleanDomain("ip-10-0-0-1.ec2.amazonaws.com"), null);
  assertEquals(cleanDomain("x.compute.amazonaws.com.cn"), null);
  assertEquals(cleanDomain("1-2-3-4.abc123.plex.direct"), null);
});

// ---------------------------------------------------------------- the official brand

Deno.test("official domain and its subdomains are never hits", () => {
  assertEquals(score("acmecu.org", ACME), null);
  assertEquals(score("www.acmecu.org", ACME), null);
  assertEquals(score("login.acmecu.org", ACME), null);
});

// ---------------------------------------------------------------- not the brand

Deno.test("a term inside an unrelated word does not count", () => {
  assertEquals(score("prometall.ru", META), null); // "meta" inside "prometall"
  assertEquals(score("chasemarshal.com", { id: "c", official_domains: ["chase.com"], terms: ["chase"] }), null);
  assertEquals(score("greenappleai.com", { id: "a", official_domains: ["apple.com"], terms: ["apple"] }), null);
  assertEquals(score("pineapple-shop.com", { id: "a", official_domains: ["apple.com"], terms: ["apple"] }), null);
});

Deno.test("glued letters that aren't a known add-on don't count (seen live: bsicloud)", () => {
  const apple = { id: "a", official_domains: ["apple.com", "icloud.com"], terms: ["apple", "icloud"] };
  assertEquals(score("monitoring.otc-bsicloud-de-prod1.bsi-software.cloud", apple), null);
  assertEquals(score("snapple.com", apple), null);
  assertEquals(score("paypal24.com", { id: "p", official_domains: ["paypal.com"], terms: ["paypal"] })?.reasons, ["glued:paypal24"]);
});

Deno.test("short terms never match by edit distance", () => {
  // "cloud" is one edit from "icloud", but only words of 6+ letters get edit-distance matching
  assertEquals(score("cloud.example.com", { id: "a", official_domains: ["icloud.com"], terms: ["icloud"] }), null);
});

Deno.test("the public suffix is not matched (a brand-named hosting platform isn't a hit)", () => {
  // "github.io" is a public suffix; "acmecu" must appear left of it to count
  assertEquals(score("someone.github.io", { id: "g", official_domains: ["github.com"], terms: ["github"] }), null);
});

// ---------------------------------------------------------------- lookalikes caught

Deno.test("exact token with bait word and risky TLD", () => {
  assertEquals(score("acmecu-login.top", ACME), {
    score: 6, severity: "suspicious", reasons: ["term:acmecu", "bait:login", "tld:top"],
  });
});

Deno.test("lookalike letters: rn for m", () => {
  assertEquals(score("acrnecu.com", ACME), {
    score: 5, severity: "suspicious", reasons: ["term:acmecu", "lookalike:acrnecu"],
  });
});

Deno.test("lookalike: digit for letter, with bait -> likely", () => {
  assertEquals(score("paypa1-login.com", { id: "p", official_domains: ["paypal.com"], terms: ["paypal"] }), {
    score: 7, severity: "likely", reasons: ["term:paypal", "lookalike:paypa1", "bait:login"],
  });
});

Deno.test("lookalike: one letter off (6+ letters)", () => {
  assertEquals(score("acmecv.com", ACME)?.reasons, ["term:acmecu", "lookalike:acmecv"]);
  assertEquals(score("netfilx.com", { id: "n", official_domains: ["netflix.com"], terms: ["netflix"] })?.severity, "suspicious");
});

Deno.test("lookalike: Cyrillic letter in punycode", () => {
  // xn--cmecu-3ve is "аcmecu" with a Cyrillic а
  assertEquals(score("xn--cmecu-3ve.com", ACME), {
    score: 5, severity: "suspicious", reasons: ["term:acmecu", "lookalike:аcmecu"],
  });
});

Deno.test("brand as a subdomain of someone else's domain", () => {
  assertEquals(score("acmecu.org.verify-acct.top", ACME), {
    score: 9, severity: "likely", reasons: ["term:acmecu", "subdomain", "bait:verify", "tld:top"],
  });
});

Deno.test("glued: short prefix is low, glued bait word counts as bait", () => {
  assertEquals(score("myacmecu.net", ACME), { score: 2, severity: "low", reasons: ["glued:myacmecu"] });
  assertEquals(score("acmeculogin.com", ACME), {
    score: 4, severity: "suspicious", reasons: ["glued:acmeculogin", "bait:login"],
  });
});

Deno.test("bait words cap at two; many hyphens add one", () => {
  assertEquals(score("acmecu-secure-login-verify.top", ACME), {
    score: 9, severity: "likely", reasons: ["term:acmecu", "bait:login", "bait:secure", "tld:top", "hyphens:3"],
  });
});

Deno.test("hyphenated terms match across tokens", () => {
  const w = { id: "h", official_domains: ["acme-cu.org"], terms: ["acme-cu"] };
  assertEquals(score("acme-cu-login.top", w)?.reasons, ["term:acme-cu", "bait:login", "tld:top"]);
  assertEquals(score("acme.cu-login.top", w), null); // the two halves are in different labels
});

// ---------------------------------------------------------------- helpers

Deno.test("skeleton folds lookalikes to the same form", () => {
  assertEquals(skeleton("acrnecu"), "acmecu");
  assertEquals(skeleton("paypa1"), "paypal");
  assertEquals(skeleton("аcmеcu"), "acmecu"); // Cyrillic а and е
  assertEquals(skeleton("ácmécu"), "acmecu"); // accents
});

Deno.test("editDistance counts one swap as one edit", () => {
  assertEquals(editDistance("paypal", "paypla"), 1);
  assertEquals(editDistance("paypal", "paypal"), 0);
  assertEquals(editDistance("acmecu", "icloud"), 5); // c lines up; the other 5 letters differ
});

// ---------------------------------------------------------------- synthetic tile, end to end

Deno.test("synthetic tile: exactly the expected hits and severities", () => {
  const domains = new Set(
    parseTile(syntheticTile())
      .flatMap((e) => parseCert(e.der, e.entryType === 1).dnsNames)
      .map(cleanDomain)
      .filter((d): d is string => d !== null),
  );
  const hits: Record<string, string> = {};
  for (const d of domains) {
    for (const w of [ACME, META]) {
      const s = scoreDomain(analyzeDomain(d), w);
      if (s) hits[`${w.id} ${d}`] = `${s.severity} ${s.score}`;
    }
  }
  assertEquals(hits, {
    "w-acme acmecu-login.top": "suspicious 6",
    "w-acme acrnecu.com": "suspicious 5",
    "w-acme acmecu.org.verify-acct.top": "likely 9",
    "w-acme acmecu-pay.xyz": "suspicious 4",
    "w-acme myacmecu.net": "low 2",
    "w-acme acmecu-secure-login-verify.top": "likely 9",
    "w-acme xn--cmecu-3ve.com": "suspicious 5",
  });
  // and what was deliberately not a hit:
  for (const d of ["acmecu.org", "www.acmecu.org", "prometall.ru", "benign-filler.example"]) {
    assertEquals(domains.has(d), true, `${d} should be in the tile`);
  }
  assertEquals(domains.has("acmecu.acm.aws.dev"), false, "AWS noise dropped before scoring");
});

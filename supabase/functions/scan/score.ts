// Score a domain against a watched brand. Explainable by design: every point awarded
// adds a reason tag, and the page shows those tags next to the hit.
//
//   term match (exact, lookalike or glued)     +2   "term:acmecu" / "glued:myacmecu"
//   lookalike rather than exact                +3   "lookalike:acrnecu"
//   brand in a subdomain of someone else's     +3   "subdomain"
//   bait word (login, verify, ...)             +2 each, max +4   "bait:login"
//   risky TLD (.top, .xyz, ...)                +2   "tld:top"
//   3+ hyphens                                 +1   "hyphens:3"
//
//   >= 7 likely phishing, 4-6 suspicious, 2-3 low. No term match -> not a hit.

import { getDomain, getPublicSuffix } from "tldts";
import { domainToUnicode } from "node:url";

export interface Watch {
  id: string;
  official_domains: string[];
  terms: string[];
}

export type Severity = "low" | "suspicious" | "likely";

export interface Score {
  score: number;
  severity: Severity;
  reasons: string[];
}

// ------------------------------------------------------------------ word lists

export const BAIT_WORDS = new Set([
  "login", "signin", "verify", "secure", "security", "account", "wallet", "support",
  "update", "billing", "confirm", "password", "recovery", "unlock",
]);

export const RISKY_TLDS = new Set([
  "top", "xyz", "zip", "click", "sbs", "icu", "cfd", "rest", "buzz", "cyou", "monster",
  "bond", "lol", "fun", "link", "quest", "shop", "online", "site", "live", "cc", "tk",
]);

// Infrastructure names that flood the log and are never brand impersonation.
export const NOISE_SUFFIXES = [
  "acm.aws.dev",
  "amazonaws.com",
  "amazonaws.com.cn",
  "cloudfront.net",
  "plex.direct",
  "dyndns.loxonecloud.com",
  "apple-virginia.herokuapp.com", // Heroku machine hostnames (direwolf-…), seen live on day 1
  "in-addr.arpa",
];

// Characters that look like Latin letters, mapped to the letter. Accented letters ("á") are
// handled by NFKD below; these are the ones Unicode doesn't decompose.
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j",
  "ѕ": "s", "ԁ": "d", "һ": "h", "ӏ": "l", "ԝ": "w", "ԛ": "q", "к": "k", "ԍ": "g", "ь": "b", "ү": "y",
  // Greek
  "ο": "o", "α": "a", "ν": "v", "ρ": "p", "ι": "i", "κ": "k", "τ": "t", "υ": "u", "ε": "e",
  "ϲ": "c", "ς": "c", "ϳ": "j", "η": "n", "ω": "w", "χ": "x",
  // Armenian
  "օ": "o", "ս": "u", "ո": "n", "հ": "h", "ց": "g", "զ": "q",
  // Latin letters with strokes or variant shapes
  "ɡ": "g", "ı": "i", "ɑ": "a", "ɩ": "i", "ł": "l", "ø": "o", "đ": "d", "ħ": "h", "ŧ": "t", "ƅ": "b",
};

// ------------------------------------------------------------------ domain cleanup

// Lowercase, strip "*." and a trailing dot; drop non-hostnames and infrastructure noise.
export function cleanDomain(name: string): string | null {
  let d = name.trim().toLowerCase();
  if (d.startsWith("*.")) d = d.slice(2);
  if (d.endsWith(".")) d = d.slice(0, -1);
  if (d.length > 253 || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) return null;
  if (NOISE_SUFFIXES.some((s) => d === s || d.endsWith("." + s))) return null;
  return d;
}

// ------------------------------------------------------------------ analysis

interface Token {
  text: string; // lowercase, punycode decoded
  label: number; // which dot-separated label it came from
}

export interface DomainInfo {
  domain: string; // cleaned ASCII form, as stored
  registrable: string | null; // eTLD+1, e.g. verify-acct.top
  tld: string;
  subdomainLabels: number; // labels to the left of the registrable domain
  matchableLabels: number; // labels to the left of the public suffix
  tokens: Token[];
  hyphens: number;
}

export function analyzeDomain(domain: string): DomainInfo {
  const labels = domain.split(".");
  const opts = { allowPrivateDomains: true };
  const registrable = getDomain(domain, opts);
  const suffix = getPublicSuffix(domain, opts) ?? labels[labels.length - 1];
  const suffixLabels = suffix.split(".").length;
  const registrableLabels = registrable ? registrable.split(".").length : suffixLabels;

  const tokens: Token[] = [];
  let hyphens = 0; // counted on the decoded name: punycode's own "xn--" hyphens don't count
  labels.forEach((label, i) => {
    const text = label.startsWith("xn--") ? (domainToUnicode(label) || label) : label;
    hyphens += (text.match(/-/g) ?? []).length;
    for (const t of text.split("-")) if (t) tokens.push({ text: t, label: i });
  });

  return {
    domain,
    registrable,
    tld: labels[labels.length - 1],
    subdomainLabels: labels.length - registrableLabels,
    matchableLabels: labels.length - suffixLabels,
    tokens,
    hyphens,
  };
}

// ------------------------------------------------------------------ scoring

export function severityOf(score: number): Severity {
  return score >= 7 ? "likely" : score >= 4 ? "suspicious" : "low";
}

export function scoreDomain(info: DomainInfo, watch: Watch): Score | null {
  const { domain } = info;
  if (watch.official_domains.some((o) => domain === o || domain.endsWith("." + o))) return null;

  const matchable = info.tokens.filter((t) => t.label < info.matchableLabels);
  let match: Match | null = null;
  for (const term of watch.terms) {
    const m = findTerm(matchable, term.toLowerCase());
    if (m && (!match || rank(m) > rank(match))) match = m;
  }
  if (!match) return null;

  let score = 2;
  const reasons: string[] = [];
  if (match.kind === "glued") reasons.push(`glued:${match.token}`);
  else reasons.push(`term:${match.term}`);
  if (match.lookalike) {
    score += 3;
    reasons.push(`lookalike:${match.token}`);
  }
  if (match.label < info.subdomainLabels) {
    score += 3;
    reasons.push("subdomain");
  }

  const baits = new Set(matchable.map((t) => t.text).filter((t) => BAIT_WORDS.has(t)));
  if (match.gluedRest && BAIT_WORDS.has(match.gluedRest)) baits.add(match.gluedRest);
  const baitList = [...baits].sort().slice(0, 2);
  score += 2 * baitList.length;
  for (const b of baitList) reasons.push(`bait:${b}`);

  if (RISKY_TLDS.has(info.tld)) {
    score += 2;
    reasons.push(`tld:${info.tld}`);
  }
  if (info.hyphens >= 3) {
    score += 1;
    reasons.push(`hyphens:${info.hyphens}`);
  }
  return { score, severity: severityOf(score), reasons };
}

// ------------------------------------------------------------------ term matching

interface Match {
  term: string;
  token: string; // the token (or hyphen-joined tokens) that matched
  label: number;
  kind: "token" | "glued";
  lookalike: boolean;
  gluedRest?: string; // what was glued to the term, e.g. "login" in "acmeculogin"
}

// Prefer exact over lookalike, whole tokens over glued.
function rank(m: Match): number {
  return (m.lookalike ? 0 : 2) + (m.kind === "token" ? 1 : 0);
}

function findTerm(tokens: Token[], term: string): Match | null {
  const parts = term.split("-").length; // a term like "acme-cu" spans two tokens
  const termSkel = skeleton(term);
  let best: Match | null = null;
  const consider = (m: Match) => {
    if (!best || rank(m) > rank(best)) best = m;
  };

  for (let i = 0; i + parts <= tokens.length; i++) {
    const window = tokens.slice(i, i + parts);
    if (window.some((t) => t.label !== window[0].label)) continue;
    const text = window.map((t) => t.text).join("-");
    const label = window[0].label;

    // 1. exact token
    if (text === term) {
      consider({ term, token: text, label, kind: "token", lookalike: false });
      continue;
    }
    // 2. lookalike token: same skeleton; same skeleton once repeated letters are squeezed
    //    ("appple", "aple", "paypaal"; terms of 5+ letters, so "metta" isn't Meta); or one edit
    //    away for longer words. The edit must not touch the first letter: "ccloud", "hcloud",
    //    "yicloud" are other companies' clouds, not iCloud, while real typosquats keep the
    //    start ("coilbase", "amazone", "paypla"). No `continue`: an exact glued match
    //    ("nokia4" = "nokia" + digits) outranks a lookalike reading of the same token.
    const skel = skeleton(text);
    const repeats = term.length >= 5 && squeeze(skel) === squeeze(termSkel);
    const oneEdit = Math.min(text.length, term.length) >= 6 && text[0] === term[0] && editDistance(text, term) === 1;
    if (skel === termSkel || repeats || oneEdit) {
      consider({ term, token: text, label, kind: "token", lookalike: true });
    }
    // 3. glued: the term plus a short prefix/suffix, a bait word or digits ("acmeculogin"),
    //    checked as written, then folded ("rnicrosoftonline" -> "microsoft" + "oniine"),
    //    then folded and squeezed ("paypaallogin" -> "paypai" + "iogin")
    if (parts === 1 && term.length >= 5) {
      const exactRest = gluedRest(text, term, "plain");
      const rest = exactRest ?? gluedRest(skel, termSkel, "folded") ?? gluedRest(squeeze(skel), squeeze(termSkel), "squeezed");
      if (rest !== null) {
        consider({ term, token: text, label, kind: "glued", lookalike: exactRest === null, gluedRest: rest });
      }
    }
  }
  return best;
}

// What's glued to the term, if it's a bait word, digits or a common add-on; else null.
// In "folded" and "squeezed" form, token and term are already in that form, and the rest is
// looked up in that form but returned as the plain word ("oniine" -> "online") so bait words
// still count.
type Form = "plain" | "folded" | "squeezed";
function gluedRest(token: string, term: string, form: Form): string | null {
  if (token.length <= term.length) return null;
  const rest = token.startsWith(term)
    ? token.slice(term.length)
    : token.endsWith(term)
    ? token.slice(0, token.length - term.length)
    : null;
  if (rest === null) return null;
  // "pineapple" isn't Apple, "chasemarshal" isn't Chase, "bsicloud" isn't iCloud:
  // only a bait word, digits or a common add-on counts ("acmeculogin", "paypal24", "myacmecu").
  if (/^\d+$/.test(rest)) return rest;
  const suffix = token.startsWith(term);
  const words = suffix ? GLUE_SUFFIX_WORDS : GLUE_PREFIX_WORDS;
  if (form === "plain") return words.plain.has(rest) ? rest : null;
  if (form === "folded") return words.folded.get(rest) ?? null;
  // Squeezing can swallow a letter at the seam: "paypal" + "login" squeezes to "paypai" + "ogin".
  // So also try the rest with the term's edge letter put back.
  const seam = suffix ? term[term.length - 1] + rest : rest + term[0];
  return words.squeezed.get(rest) ?? words.squeezed.get(seam) ?? null;
}

// Allowed glue words: bait words plus common add-ons, each indexed as written and folded.
function glueWords(addOns: string[]) {
  const plain = new Set([...BAIT_WORDS, ...addOns]);
  return {
    plain,
    folded: new Map([...plain].map((w) => [skeleton(w), w])),
    squeezed: new Map([...plain].map((w) => [squeeze(skeleton(w)), w])),
  };
}
const GLUE_PREFIX_WORDS = glueWords(["my", "get", "go", "the", "e", "i", "www", "app", "web", "mobile", "online"]);
const GLUE_SUFFIX_WORDS = glueWords(["app", "id", "hq", "us", "uk", "eu", "online", "web", "mobile", "help", "team"]);

// Fold lookalike characters to a common form: "асmеcu" (Cyrillic), "acrnecu", "acm3cu" -> "acmecu".
// (Applied to both the token and the term, so only equality of skeletons matters.)
// NFKD also turns full-width (ａ) and math-styled (𝐚) letters into plain ones.
export function skeleton(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFKD")) {
    if (/\p{M}/u.test(ch)) continue; // drop accents
    out += CONFUSABLES[ch] ?? ch;
  }
  return out
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/0/g, "o")
    .replace(/[l1|]/g, "i") // i, l, 1 and | look alike: "lcloud" and "1cloud" both fold to "icloud"
    .replace(/3/g, "e")
    .replace(/5/g, "s");
}

// Collapse runs of the same letter: "appple" and "aple" both squeeze to "apie" (after folding).
export function squeeze(s: string): string {
  return s.replace(/(.)\1+/g, "$1");
}

// Optimal string alignment distance (Levenshtein plus adjacent swaps).
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

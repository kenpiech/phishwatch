// Pure display and validation helpers, shared by the page and its tests.

// Domains from the log may be live phishing sites: show them defanged and never as links.
// "acmecu-login.top" -> "acmecu-login[.]top" (only the last dot, which is enough to break autolinking)
export function defang(domain: string): string {
  const i = domain.lastIndexOf(".");
  return i < 0 ? domain : `${domain.slice(0, i)}[.]${domain.slice(i + 1)}`;
}

// Third-party lookups for a domain. These link to urlscan/VirusTotal, never to the domain itself.
export function investigateLinks(domain: string) {
  const d = encodeURIComponent(domain);
  return [
    { label: "urlscan", href: `https://urlscan.io/search/#page.domain:${d}` },
    { label: "VirusTotal", href: `https://www.virustotal.com/gui/domain/${d}` },
  ];
}

// The worker's reason tags ("bait:login") as words for people.
export function reasonLabel(tag: string): string {
  const [kind, value = ""] = tag.split(":");
  switch (kind) {
    case "term":
      return `brand “${value}”`;
    case "lookalike":
      return `lookalike “${value}”`;
    case "glued":
      return `brand inside “${value}”`;
    case "subdomain":
      return "brand as a subdomain";
    case "bait":
      return `bait word: ${value}`;
    case "tld":
      return `TLD .${value}`;
    case "hyphens":
      return `${value} hyphens`;
    default:
      return tag;
  }
}

export function timeAgo(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

export function compactNumber(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)} k`;
  return n.toLocaleString("en-US");
}

// ------------------------------------------------------------------ watch validation
// Mirrors the database checks (pw_valid_domains / pw_valid_terms) so errors are friendly.

export const MAX_WATCHES = 5;
const HOSTNAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const TERM = /^[a-z0-9-]{4,30}$/;
export const STOPLIST = new Set([
  "login", "secure", "bank", "mail", "email", "account", "online", "shop", "store",
  "cloud", "home", "info", "site", "support", "verify", "update", "service", "wallet",
  "signin", "billing", "test", "free", "news", "user", "admin", "portal", "server",
  "host", "media", "digital", "global", "group", "network", "tech", "data", "auth",
]);

// Split "acmecu.org, www.acmecu.org" or one-per-line input into clean, unique items.
export function splitList(input: string): string[] {
  return [...new Set(input.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

// Strip a pasted URL down to its hostname: "https://www.AcmeCU.org/login" -> "www.acmecu.org"
export function normalizeDomain(input: string): string {
  return input.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/\.$/, "");
}

// Suggest a term from the first official domain: "acmecu.org" -> "acmecu", "www.acme-cu.co.uk" -> "acme-cu"
export function suggestTerm(domain: string): string {
  const labels = normalizeDomain(domain).replace(/^www\./, "").split(".");
  if (labels.length < 2) return "";
  // the label left of the TLD, or left of a 2-letter second-level like co.uk
  const i = labels.length >= 3 && labels[labels.length - 2].length <= 3 ? labels.length - 3 : labels.length - 2;
  return labels[i] ?? "";
}

export interface WatchInput {
  name: string;
  official_domains: string[];
  terms: string[];
}

export function validateWatch(w: WatchInput): string | null {
  const name = w.name.trim();
  if (name.length < 1 || name.length > 60) return "Give the brand a name (up to 60 characters).";
  if (w.official_domains.length < 1 || w.official_domains.length > 3) return "List 1 to 3 official domains.";
  const badDomain = w.official_domains.find((d) => d.length > 253 || !HOSTNAME.test(d));
  if (badDomain) return `“${badDomain}” isn't a domain name like acmecu.org.`;
  if (w.terms.length < 1 || w.terms.length > 5) return "List 1 to 5 terms.";
  const badTerm = w.terms.find((t) => !TERM.test(t));
  if (badTerm) return `“${badTerm}”: terms are 4–30 lowercase letters, digits or hyphens.`;
  const generic = w.terms.find((t) => STOPLIST.has(t));
  if (generic) return `“${generic}” is too generic: it would match thousands of unrelated sites.`;
  return null;
}

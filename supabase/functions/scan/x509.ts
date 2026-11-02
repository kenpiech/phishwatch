// Minimal X.509 DER walker: just enough to read the domain names (Subject Alternative
// Name dNSName entries) and the issuer's display name from a certificate.
//
// TBSCertificate ::= SEQUENCE {
//   [0] version (optional), serialNumber, signature, issuer Name, validity,
//   subject Name, subjectPublicKeyInfo, [1] [2] unique IDs (optional),
//   [3] extensions (optional) -> SEQUENCE OF Extension }
// Extension ::= SEQUENCE { extnID OID, critical BOOLEAN (optional), extnValue OCTET STRING }
// SAN (2.5.29.17) extnValue holds GeneralNames; a dNSName is [2] IMPLICIT IA5String (tag 0x82).

export interface CertInfo {
  dnsNames: string[]; // raw SAN dNSNames, as written in the certificate
  subjectCN: string | null;
  issuer: string | null; // issuer O, else issuer CN
}

export class DerError extends Error {
  override name = "DerError";
}

const TAG = {
  INTEGER: 0x02,
  OCTET_STRING: 0x04,
  OID: 0x06,
  SEQUENCE: 0x30,
  SET: 0x31,
  BOOLEAN: 0x01,
  VERSION: 0xa0, // [0] EXPLICIT
  EXTENSIONS: 0xa3, // [3] EXPLICIT
  DNS_NAME: 0x82, // [2] IMPLICIT IA5String
} as const;

// OID content bytes
const OID_SAN = [0x55, 0x1d, 0x11]; // 2.5.29.17
const OID_CN = [0x55, 0x04, 0x03]; // 2.5.4.3
const OID_O = [0x55, 0x04, 0x0a]; // 2.5.4.10

interface Tlv {
  tag: number;
  start: number; // first content byte
  end: number; // one past the last content byte
}

function readTlv(buf: Uint8Array, off: number, limit = buf.length): Tlv {
  if (off + 2 > limit) throw new DerError(`TLV header past end at ${off}`);
  const tag = buf[off];
  if ((tag & 0x1f) === 0x1f) throw new DerError(`multi-byte tag at ${off}`);
  let len = buf[off + 1];
  let start = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new DerError(`bad length form at ${off}`);
    if (start + n > limit) throw new DerError(`length past end at ${off}`);
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[start + i];
    start += n;
  }
  const end = start + len;
  if (end > limit) throw new DerError(`value past end at ${off} (tag 0x${tag.toString(16)})`);
  return { tag, start, end };
}

// The children of a constructed value, in order.
function children(buf: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let off = parent.start;
  while (off < parent.end) {
    const t = readTlv(buf, off, parent.end);
    out.push(t);
    off = t.end;
  }
  return out;
}

function expectTag(t: Tlv | undefined, tag: number, what: string): Tlv {
  if (!t || t.tag !== tag) {
    throw new DerError(`expected ${what} (0x${tag.toString(16)}), got ${t ? "0x" + t.tag.toString(16) : "nothing"}`);
  }
  return t;
}

function sameBytes(buf: Uint8Array, t: Tlv, want: number[]): boolean {
  if (t.end - t.start !== want.length) return false;
  for (let i = 0; i < want.length; i++) if (buf[t.start + i] !== want[i]) return false;
  return true;
}

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8");

function decodeString(buf: Uint8Array, t: Tlv): string {
  const raw = buf.subarray(t.start, t.end);
  switch (t.tag) {
    case 0x0c: // UTF8String
      return utf8.decode(raw);
    case 0x1e: { // BMPString (UTF-16BE)
      let s = "";
      for (let i = 0; i + 1 < raw.length; i += 2) s += String.fromCharCode((raw[i] << 8) | raw[i + 1]);
      return s;
    }
    default: // PrintableString, IA5String, TeletexString, ...
      return latin1.decode(raw);
  }
}

// Name ::= SEQUENCE OF SET OF SEQUENCE { type OID, value ANY }
function nameAttrs(buf: Uint8Array, name: Tlv): Map<string, string> {
  const out = new Map<string, string>();
  for (const rdn of children(buf, name)) {
    if (rdn.tag !== TAG.SET) continue;
    for (const atv of children(buf, rdn)) {
      const [oid, value] = children(buf, atv);
      if (!oid || oid.tag !== TAG.OID || !value) continue;
      if (sameBytes(buf, oid, OID_CN) && !out.has("CN")) out.set("CN", decodeString(buf, value));
      if (sameBytes(buf, oid, OID_O) && !out.has("O")) out.set("O", decodeString(buf, value));
    }
  }
  return out;
}

function sanDnsNames(buf: Uint8Array, extensions: Tlv): string[] {
  const seq = expectTag(children(buf, extensions)[0], TAG.SEQUENCE, "Extensions");
  for (const ext of children(buf, seq)) {
    const parts = children(buf, ext);
    const oid = expectTag(parts[0], TAG.OID, "extnID");
    if (!sameBytes(buf, oid, OID_SAN)) continue;
    const value = expectTag(parts[parts.length - 1], TAG.OCTET_STRING, "extnValue");
    const generalNames = expectTag(readTlv(buf, value.start, value.end), TAG.SEQUENCE, "GeneralNames");
    return children(buf, generalNames)
      .filter((g) => g.tag === TAG.DNS_NAME)
      .map((g) => latin1.decode(buf.subarray(g.start, g.end)));
  }
  return [];
}

// der is a full Certificate (log entry type 0) or a bare TBSCertificate (type 1).
export function parseCert(der: Uint8Array, isTbs: boolean): CertInfo {
  let tbs = expectTag(readTlv(der, 0), TAG.SEQUENCE, isTbs ? "TBSCertificate" : "Certificate");
  if (!isTbs) tbs = expectTag(children(der, tbs)[0], TAG.SEQUENCE, "TBSCertificate");

  const fields = children(der, tbs);
  let i = 0;
  if (fields[i]?.tag === TAG.VERSION) i++;
  expectTag(fields[i++], TAG.INTEGER, "serialNumber");
  expectTag(fields[i++], TAG.SEQUENCE, "signature");
  const issuer = nameAttrs(der, expectTag(fields[i++], TAG.SEQUENCE, "issuer"));
  expectTag(fields[i++], TAG.SEQUENCE, "validity");
  const subject = nameAttrs(der, expectTag(fields[i++], TAG.SEQUENCE, "subject"));
  expectTag(fields[i++], TAG.SEQUENCE, "subjectPublicKeyInfo");
  const extensions = fields.slice(i).find((f) => f.tag === TAG.EXTENSIONS);

  return {
    dnsNames: extensions ? sanDnsNames(der, extensions) : [],
    subjectCN: subject.get("CN") ?? null,
    issuer: issuer.get("O") ?? issuer.get("CN") ?? null,
  };
}

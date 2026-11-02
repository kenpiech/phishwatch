// Row shapes as the page reads them (see supabase/migrations/*_schema.sql).

export type Severity = "low" | "suspicious" | "likely";

export interface Watch {
  id: string;
  name: string;
  official_domains: string[];
  terms: string[];
  created_at: string;
}

export interface Preset {
  id: number;
  name: string;
  official_domains: string[];
  terms: string[];
}

export interface Hit {
  id: number;
  watch_id: string;
  domain: string;
  registrable: string | null;
  score: number;
  severity: Severity;
  reasons: string[];
  issuer: string | null;
  entry_type: 0 | 1 | null;
  entry_ts: string;
  log_index: number;
  last_seen_at: string;
  seen_count: number;
  created_at: string;
}

export interface Run {
  id: number;
  ran_at: string;
  ok: boolean;
  note: string | null;
  error: string | null;
  scanned: number;
  domains: number;
  skipped: number;
  hits_inserted: number;
  hits_updated: number;
}

export interface ScanStats {
  scanned_today: number;
  domains_today: number;
  runs_today: number;
}

export const HIT_COLUMNS =
  "id, watch_id, domain, registrable, score, severity, reasons, issuer, entry_type, entry_ts, log_index, last_seen_at, seen_count, created_at";
export const RUN_COLUMNS = "id, ran_at, ok, note, error, scanned, domains, skipped, hits_inserted, hits_updated";

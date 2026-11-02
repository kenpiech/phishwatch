// Edge Function entry point. Called by Supabase Cron every 10 s with the secret key in
// the `apikey` header; withSupabase rejects anyone else with a 401. Deployed with
// verify_jwt = false, because the new secret keys aren't JWTs (see Supabase's
// "Securing Edge Functions" guide).

import { withSupabase } from "@supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type Claim, type Db, runScan } from "./worker.ts";
import type { Watch } from "./score.ts";

// The worker's view of the database: two RPCs (see the worker_rpcs migration) and one read.
function supabaseDb(admin: SupabaseClient): Db {
  return {
    async claim() {
      const { data, error } = await admin.rpc("claim_scan");
      if (error) throw new Error(`claim_scan: ${error.message}`);
      return data as Claim;
    },
    async watches() {
      const { data, error } = await admin.from("watches").select("id, official_domains, terms");
      if (error) throw new Error(`watches: ${error.message}`);
      return data as Watch[];
    },
    async finish(run, hits, nextTile, backoff) {
      const { data, error } = await admin.rpc("finish_scan", {
        p_run: run,
        p_hits: hits,
        p_next_tile: nextTile,
        p_backoff: backoff,
      });
      if (error) throw new Error(`finish_scan: ${error.message}`);
      return data as { inserted: number; updated: number };
    },
  };
}

export default {
  fetch: withSupabase({ auth: "secret" }, async (_req, ctx) => {
    const result = await runScan({ db: supabaseDb(ctx.supabaseAdmin), fetch });
    return Response.json(result, { status: result.status === "error" ? 502 : 200 });
  }),
};

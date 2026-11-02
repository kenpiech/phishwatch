-- The two calls the scan worker makes, one at the start of a run and one at the end.
-- Only service_role (the secret key) may execute them.

-- Start of a run: honour the kill switch, the backoff and the lease (no overlapping runs).
-- Logs its own runs row when it refuses, so every invocation leaves a trace.
create function public.claim_scan(p_lease_seconds integer default 60) returns jsonb
language plpgsql set search_path = '' as $$
declare
  s public.scan_state;
begin
  select * into s from public.scan_state where id = 1 for update;

  if not s.enabled then
    insert into public.runs (ok, note) values (true, 'disabled');
    return jsonb_build_object('status', 'disabled');
  end if;

  if s.backoff_until is not null and s.backoff_until > now() then
    insert into public.runs (ok, note, error) values (
      false, 'backing off',
      format('Paused after failures until %s UTC', to_char(s.backoff_until at time zone 'utc', 'HH24:MI:SS'))
    );
    return jsonb_build_object('status', 'backoff');
  end if;

  if s.lock_until is not null and s.lock_until > now() then
    insert into public.runs (ok, note) values (true, 'skipped: busy');
    return jsonb_build_object('status', 'busy');
  end if;

  update public.scan_state
     set lock_until = now() + make_interval(secs => p_lease_seconds)
   where id = 1;

  return jsonb_build_object(
    'status', 'ok',
    'log_url', s.log_url,
    'tiles_per_run', s.tiles_per_run,
    'next_tile', s.next_tile
  );
end $$;

-- End of a run, in one transaction: upsert hits, log the run, move the cursor, release the lease.
--   p_run:       {ok, note, error, scanned, domains, skipped, tree_size, tile_from, tile_to,
--                 fetch_ms, parse_ms, duration_ms}
--   p_hits:      [{watch_id, domain, registrable, score, severity, reasons, issuer,
--                  entry_type, entry_ts, log_index}]
--   p_next_tile: new cursor on success (null leaves it)
--   p_backoff:   true on a 429/5xx from the log, to pause 5 minutes right away
create function public.finish_scan(
  p_run jsonb,
  p_hits jsonb default '[]'::jsonb,
  p_next_tile bigint default null,
  p_backoff boolean default false
) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_ok       boolean := coalesce((p_run ->> 'ok')::boolean, false);
  v_inserted integer := 0;
  v_updated  integer := 0;
  v_run_id   bigint;
begin
  if v_ok and jsonb_array_length(coalesce(p_hits, '[]'::jsonb)) > 0 then
    with incoming as (
      -- one row per (watch, domain), newest sighting wins; skip watches deleted mid-run
      select distinct on (h.watch_id, h.domain) h.*
      from jsonb_to_recordset(p_hits) as h(
        watch_id uuid, domain text, registrable text, score smallint, severity text,
        reasons text[], issuer text, entry_type smallint, entry_ts timestamptz, log_index bigint
      )
      where exists (select 1 from public.watches w where w.id = h.watch_id)
      order by h.watch_id, h.domain, h.entry_ts desc
    ),
    upserted as (
      insert into public.hits as t (
        watch_id, domain, registrable, score, severity, reasons, issuer,
        entry_type, entry_ts, log_index, last_seen_at
      )
      select watch_id, domain, registrable, score, severity, reasons, issuer,
             entry_type, entry_ts, log_index, entry_ts
      from incoming
      on conflict (watch_id, domain) do update
        set last_seen_at = excluded.last_seen_at,
            seen_count   = t.seen_count + 1
        where t.last_seen_at < excluded.last_seen_at   -- only a newer sighting counts as a change
      returning (t.xmax = 0) as inserted               -- xmax = 0 means a fresh insert
    )
    select count(*) filter (where inserted), count(*) filter (where not inserted)
      into v_inserted, v_updated
    from upserted;
  end if;

  insert into public.runs (
    ok, note, error, scanned, domains, skipped, hits_inserted, hits_updated,
    tree_size, tile_from, tile_to, fetch_ms, parse_ms, duration_ms
  ) values (
    v_ok, p_run ->> 'note', left(p_run ->> 'error', 500),
    coalesce((p_run ->> 'scanned')::integer, 0),
    coalesce((p_run ->> 'domains')::integer, 0),
    coalesce((p_run ->> 'skipped')::integer, 0),
    v_inserted, v_updated,
    (p_run ->> 'tree_size')::bigint, (p_run ->> 'tile_from')::bigint, (p_run ->> 'tile_to')::bigint,
    (p_run ->> 'fetch_ms')::integer, (p_run ->> 'parse_ms')::integer, (p_run ->> 'duration_ms')::integer
  ) returning id into v_run_id;

  if v_ok then
    update public.scan_state
       set next_tile = coalesce(p_next_tile, next_tile),
           consecutive_failures = 0,
           backoff_until = null,
           lock_until = null,
           updated_at = now()
     where id = 1;
  else
    update public.scan_state
       set consecutive_failures = consecutive_failures + 1,
           backoff_until = case
             when p_backoff or consecutive_failures + 1 >= 5 then now() + interval '5 minutes'
             else backoff_until
           end,
           lock_until = null,
           updated_at = now()
     where id = 1;
  end if;

  return jsonb_build_object('run_id', v_run_id, 'inserted', v_inserted, 'updated', v_updated);
end $$;

revoke execute on function public.claim_scan(integer), public.finish_scan(jsonb, jsonb, bigint, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_scan(integer), public.finish_scan(jsonb, jsonb, bigint, boolean)
  to service_role;

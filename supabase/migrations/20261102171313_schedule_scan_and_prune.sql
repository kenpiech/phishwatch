-- Schedule the scan worker every 10 s, and prune old rows once a day.
-- Kill switch: update scan_state set enabled = false;   Full stop: select cron.unschedule('scan-every-10s');

create extension if not exists pg_cron;

-- Every 10 s: POST to the scan function with the secret key, both read from Vault at call time.
select cron.schedule(
  'scan-every-10s',
  '10 seconds',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/scan',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'phishwatch_supabase_secret_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

-- Daily retention, so the free 500 MB database never fills:
--   hits older than 30 days, and anything beyond the newest 1,000 per watch
--   runs older than 2 days (8,640 rows a day)
--   cron's own run history older than 1 day (also 8,640 rows a day)
create function public.pw_prune() returns jsonb
language plpgsql set search_path = '' as $$
declare
  n_hits_old int; n_hits_cap int; n_runs int; n_cron int;
begin
  delete from public.hits where created_at < now() - interval '30 days';
  get diagnostics n_hits_old = row_count;

  delete from public.hits where id in (
    select id from (
      select id, row_number() over (partition by watch_id order by created_at desc) as rn
      from public.hits
    ) ranked where rn > 1000
  );
  get diagnostics n_hits_cap = row_count;

  delete from public.runs where ran_at < now() - interval '2 days';
  get diagnostics n_runs = row_count;

  delete from cron.job_run_details where end_time < now() - interval '1 day';
  get diagnostics n_cron = row_count;

  return jsonb_build_object('hits_old', n_hits_old, 'hits_over_cap', n_hits_cap, 'runs', n_runs, 'cron_history', n_cron);
end $$;

revoke execute on function public.pw_prune() from public, anon, authenticated;

select cron.schedule('prune-daily', '17 3 * * *', $$ select public.pw_prune(); $$);

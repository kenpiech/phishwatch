-- Today's totals for the status bar ("1.9 M certificates checked today"), summed in the
-- database so the page doesn't download every runs row. Runs are readable by any signed-in
-- user already; this only aggregates them.
create function public.scan_stats() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'scanned_today', coalesce(sum(scanned), 0),
    'domains_today', coalesce(sum(domains), 0),
    'runs_today', count(*),
    'since', date_trunc('day', now() at time zone 'utc') at time zone 'utc'
  )
  from public.runs
  where ran_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
$$;

revoke execute on function public.scan_stats() from public, anon;
grant execute on function public.scan_stats() to authenticated;

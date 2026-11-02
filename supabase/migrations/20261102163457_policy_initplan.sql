-- Same policies, written as (select auth.jwt()) ->> 'sub' so the advisor sees the JWT
-- is read once per query, not once per row.
alter policy "watches: owner reads"   on public.watches using (user_id = ((select auth.jwt()) ->> 'sub'));
alter policy "watches: owner inserts" on public.watches with check (user_id = ((select auth.jwt()) ->> 'sub'));
alter policy "watches: owner updates" on public.watches
  using (user_id = ((select auth.jwt()) ->> 'sub'))
  with check (user_id = ((select auth.jwt()) ->> 'sub'));
alter policy "watches: owner deletes" on public.watches using (user_id = ((select auth.jwt()) ->> 'sub'));
alter policy "hits: owner of the watch reads" on public.hits
  using (exists (
    select 1 from public.watches w
    where w.id = hits.watch_id and w.user_id = ((select auth.jwt()) ->> 'sub')
  ));

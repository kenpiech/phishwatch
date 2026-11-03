-- A fenced hook so the Playwright test can create a hit on demand (real hits only come from
-- the scan worker). It refuses unless all three hold:
--   1. the caller is a listed test account (test_users: service role only, like scan_state)
--   2. the watch belongs to the caller
--   3. the domain ends in .invalid, a name reserved by RFC 2606 that can never be a real site

create table public.test_users (
  user_id text primary key,
  note    text
);
alter table public.test_users enable row level security;   -- no policies: clients can't read or write
revoke all on public.test_users from anon, authenticated;
grant all on public.test_users to service_role;

insert into public.test_users (user_id, note) values
  ('user_3LZRZqB1y0jfeylth4wZEQm5bvV', 'phishwatch-test-a+clerk_test@example.com (Clerk dev)'),
  ('user_3LZRa12DdFnZJQFzzPfrNqADKv9', 'phishwatch-test-b+clerk_test@example.com (Clerk dev)');

create function public.pw_test_insert_hit(p_watch_id uuid, p_domain text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  me text := (select auth.jwt()) ->> 'sub';
  v_id bigint;
begin
  if me is null or not exists (select 1 from public.test_users where user_id = me) then
    raise exception 'pw_test_insert_hit is only for test accounts' using errcode = '42501';
  end if;
  if not exists (select 1 from public.watches where id = p_watch_id and user_id = me) then
    raise exception 'not your watch' using errcode = '42501';
  end if;
  if p_domain !~ '^[a-z0-9.-]+\.invalid$' then
    raise exception 'test domains must end in .invalid' using errcode = '22023';
  end if;

  insert into public.hits (watch_id, domain, registrable, score, severity, reasons, issuer,
                           entry_type, entry_ts, log_index, last_seen_at)
  values (p_watch_id, p_domain, p_domain, 9, 'likely', array['test:playwright'], 'Playwright test',
          0, now(), 0, now())
  returning id into v_id;
  return v_id;
end $$;

revoke execute on function public.pw_test_insert_hit(uuid, text) from public, anon;
grant execute on function public.pw_test_insert_hit(uuid, text) to authenticated;

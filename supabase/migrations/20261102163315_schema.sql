-- phishwatch schema: presets, watches, hits, runs, scan_state.
-- RLS keys on the Clerk user id: auth.jwt()->>'sub' (Supabase third-party auth).

-- ---------------------------------------------------------------- validation

-- 1-3 official domains, each a lowercase hostname.
create function public.pw_valid_domains(d text[]) returns boolean
language sql immutable set search_path = '' as $$
  select cardinality(d) between 1 and 3
     and not exists (
       select 1 from unnest(d) as x
       where x is null
          or char_length(x) > 253
          or x !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$'
     )
$$;

-- 1-5 terms, each 4-30 of [a-z0-9-], none a generic word that would match everything.
create function public.pw_valid_terms(t text[]) returns boolean
language sql immutable set search_path = '' as $$
  select cardinality(t) between 1 and 5
     and not exists (
       select 1 from unnest(t) as x
       where x is null
          or x !~ '^[a-z0-9-]{4,30}$'
          or x = any (array[
               'login','secure','bank','mail','email','account','online','shop','store',
               'cloud','home','info','site','support','verify','update','service','wallet',
               'signin','billing','test','free','news','user','admin','portal','server',
               'host','media','digital','global','group','network','tech','data','auth'
             ])
     )
$$;

-- ---------------------------------------------------------------- tables

create table public.presets (
  id               smallint generated always as identity primary key,
  name             text   not null unique,
  official_domains text[] not null check (public.pw_valid_domains(official_domains)),
  terms            text[] not null check (public.pw_valid_terms(terms))
);

create table public.watches (
  id               uuid        primary key default gen_random_uuid(),
  user_id          text        not null default (auth.jwt() ->> 'sub'),
  name             text        not null check (char_length(btrim(name)) between 1 and 60),
  official_domains text[]      not null check (public.pw_valid_domains(official_domains)),
  terms            text[]      not null check (public.pw_valid_terms(terms)),
  created_at       timestamptz not null default now()
);
create index watches_user_id_idx on public.watches (user_id);

-- At most 5 watches per user.
create function public.pw_watch_limit() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select count(*) from public.watches where user_id = new.user_id) >= 5 then
    raise exception 'You can watch at most 5 brands.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger watches_limit before insert on public.watches
  for each row execute function public.pw_watch_limit();

-- One row per (watch, domain). The worker upserts: a new pair inserts; a newer
-- sighting of the same pair bumps last_seen_at and seen_count; a repeat changes nothing.
create table public.hits (
  id           bigint      generated always as identity primary key,
  watch_id     uuid        not null references public.watches (id) on delete cascade,
  domain       text        not null,
  registrable  text,
  score        smallint    not null,
  severity     text        not null check (severity in ('low', 'suspicious', 'likely')),
  reasons      text[]      not null default '{}',
  issuer       text,
  entry_type   smallint    check (entry_type in (0, 1)),   -- 0 = certificate, 1 = precertificate
  entry_ts     timestamptz not null,                       -- when the log first recorded it
  log_index    bigint      not null,
  last_seen_at timestamptz not null,
  seen_count   integer     not null default 1,
  created_at   timestamptz not null default now(),
  unique (watch_id, domain)
);
create index hits_watch_created_idx on public.hits (watch_id, created_at desc);

-- One row per worker run, successful or not.
create table public.runs (
  id            bigint      generated always as identity primary key,
  ran_at        timestamptz not null default now(),
  ok            boolean     not null,
  note          text,
  error         text,
  scanned       integer     not null default 0,  -- log entries parsed
  domains       integer     not null default 0,  -- unique domains scored
  skipped       integer     not null default 0,  -- full tiles not read (sampling)
  hits_inserted integer     not null default 0,
  hits_updated  integer     not null default 0,
  tree_size     bigint,
  tile_from     bigint,
  tile_to       bigint,
  fetch_ms      integer,
  parse_ms      integer,
  duration_ms   integer
);
create index runs_ran_at_idx on public.runs (ran_at desc);

-- Worker config and cursor. Exactly one row. No client access at all.
create table public.scan_state (
  id                   smallint    primary key default 1 check (id = 1),
  enabled              boolean     not null default true,
  log_url              text        not null,
  tiles_per_run        smallint    not null default 1 check (tiles_per_run between 1 and 3),
  next_tile            bigint,
  backoff_until        timestamptz,
  consecutive_failures integer     not null default 0,
  lock_until           timestamptz,
  updated_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------- RLS

alter table public.presets    enable row level security;
alter table public.watches    enable row level security;
alter table public.hits       enable row level security;
alter table public.runs       enable row level security;
alter table public.scan_state enable row level security;

create policy "presets: signed-in users read" on public.presets
  for select to authenticated using (true);

create policy "watches: owner reads"   on public.watches for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
create policy "watches: owner inserts" on public.watches for insert to authenticated
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy "watches: owner updates" on public.watches for update to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'))
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy "watches: owner deletes" on public.watches for delete to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));

create policy "hits: owner of the watch reads" on public.hits
  for select to authenticated
  using (exists (
    select 1 from public.watches w
    where w.id = hits.watch_id and w.user_id = (select auth.jwt() ->> 'sub')
  ));

create policy "runs: signed-in users read" on public.runs
  for select to authenticated using (true);

-- scan_state: RLS on, no policies -> clients can't touch it.

-- ---------------------------------------------------------------- grants
-- Start from nothing, then grant only what each role needs.

revoke all on public.presets, public.watches, public.hits, public.runs, public.scan_state
  from anon, authenticated;

grant select on public.presets, public.hits, public.runs to authenticated;
grant select, delete on public.watches to authenticated;
grant insert (name, official_domains, terms), update (name, official_domains, terms)
  on public.watches to authenticated;

-- The worker uses the secret key (service_role, bypasses RLS).
grant all on public.presets, public.watches, public.hits, public.runs, public.scan_state
  to service_role;

revoke execute on function public.pw_valid_domains(text[]), public.pw_valid_terms(text[]),
  public.pw_watch_limit() from public, anon;
grant execute on function public.pw_valid_domains(text[]), public.pw_valid_terms(text[])
  to authenticated, service_role;

-- ---------------------------------------------------------------- realtime
-- Postgres changes for hits and runs (INSERT only is subscribed by the page).

alter publication supabase_realtime add table public.hits, public.runs;

-- ---------------------------------------------------------------- seed

insert into public.scan_state (log_url)
values ('https://storage.googleapis.com/parcelyard2027h1.prod.certificate.transparency.goog/');

insert into public.presets (name, official_domains, terms) values
  ('PayPal',    '{paypal.com}',                      '{paypal}'),
  ('Microsoft', '{microsoft.com,office.com,live.com}', '{microsoft,office365,outlook}'),
  ('Apple',     '{apple.com,icloud.com}',            '{apple,icloud}'),
  ('Amazon',    '{amazon.com}',                      '{amazon}'),
  ('Coinbase',  '{coinbase.com}',                    '{coinbase}'),
  ('Netflix',   '{netflix.com}',                     '{netflix}');

-- Demo watches owned by a placeholder user no one can sign in as, so the worker has
-- something to score before real users exist. RLS hides them from everyone.
insert into public.watches (user_id, name, official_domains, terms)
select 'phishwatch:demo', name, official_domains, terms
from public.presets order by id limit 5;

-- pg_net lets Postgres make HTTP requests: Supabase Cron uses it to call the scan function.
create extension if not exists pg_net with schema extensions;

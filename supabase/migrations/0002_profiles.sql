-- 0002_profiles.sql
-- The user table. Kitab does NOT use Supabase Auth / email verification — the
-- backend creates users itself (guest-first) and mints a JWT signed with the
-- project JWT secret, so PostgREST RLS still resolves auth.uid() = profiles.id.
-- profiles is therefore standalone (no FK to auth.users).
--
-- Identity for returning users is the device_id (stable, anonymous). Email is
-- optional and only attached if/when the user chooses to link one later.

create table if not exists public.profiles (
  id           uuid primary key default extensions.gen_random_uuid(),
  device_id    text unique,                 -- stable anonymous identity
  email        text unique,                 -- optional, linked later
  is_guest     boolean not null default true,
  handle       text unique,
  display_name text,
  language     text not null default 'en' check (language in ('en', 'hi')),
  intent       text,
  rhythm       text not null default 'morning' check (rhythm in ('morning', 'commute', 'winddown')),
  mode         text not null default 'listen'  check (mode in ('read', 'listen')),
  onboarded    boolean not null default false,
  timezone     text not null default 'UTC',
  -- denormalised activity counters for cheap profile reads (kept by triggers)
  days_used      integer not null default 0,
  last_active_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger set_updated_at before update on public.profiles
  for each row execute function public.tg_set_updated_at();

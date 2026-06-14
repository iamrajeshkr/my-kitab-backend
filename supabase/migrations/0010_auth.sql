-- 0010_auth.sql
-- Username + password accounts (custom auth — no Supabase Auth, no email).
-- The backend hashes passwords (scrypt) and mints its own JWT.

alter table public.profiles
  add column if not exists username      text unique,
  add column if not exists password_hash text;

-- usernames are stored lowercased by the API; index supports fast lookup.
create index if not exists idx_profiles_username on public.profiles (username);

-- 0001_extensions.sql
-- Extensions live in the `extensions` schema (Supabase convention). We qualify
-- the vector type as extensions.vector and set search_path on functions that
-- need the distance operators (<=>, <->).

create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto    with schema extensions;
create extension if not exists pg_trgm     with schema extensions;
create extension if not exists vector      with schema extensions;

-- Embedding dimensionality is fixed by the model (Gemini text-embedding-004 = 768).
-- If you swap models, bump this everywhere (column types + backfill) in one migration.
comment on extension vector is 'pgvector — embedding dim 768 (Gemini text-embedding-004)';

-- Shared enums -------------------------------------------------------------
do $$ begin
  create type public.content_kind  as enum ('byte', 'journey', 'summary');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.weather as enum ('heavy', 'restless', 'cloudy', 'clear', 'bright');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.practice_status as enum ('active', 'kept', 'released');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.memory_kind as enum ('fact', 'preference', 'theme', 'milestone');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.event_type as enum (
    'page_open', 'page_complete',
    'listen_start', 'listen_progress', 'listen_complete',
    'highlight', 'reflection',
    'practice_set', 'practice_kept', 'practice_released',
    'weather_checkin',
    'sit_start', 'sit_complete',
    'save', 'unsave',
    'arc_enroll', 'arc_advance',
    'ask_line', 'compose_page'
  );
exception when duplicate_object then null; end $$;

-- Generic updated_at trigger fn (used across tables) -----------------------
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

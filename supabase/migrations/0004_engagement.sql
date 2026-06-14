-- 0004_engagement.sql
-- The data faucet. Everything the user does becomes an append-only event;
-- derived state (practices, progress, saved, weather) gets its own typed table
-- for cheap reads. The Mirror, garden, and recommendations all draw from here.

-- Append-only event log -----------------------------------------------------
-- BRIN on created_at: tiny index, perfect for an append-only time series.
-- At scale this becomes a monthly RANGE-partitioned table (see ARCHITECTURE.md).
create table if not exists public.events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,                 -- no FK: real + synthetic users share the log
  type       public.event_type not null,
  item_kind  public.content_kind,
  item_id    uuid,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_events_user_time on public.events (user_id, created_at desc);
create index if not exists idx_events_item       on public.events (item_kind, item_id) where item_id is not null;
create index if not exists idx_events_type_time   on public.events (type, created_at desc);
create index if not exists idx_events_created_brin on public.events using brin (created_at);

-- Inner weather check-ins ---------------------------------------------------
create table if not exists public.weather_checkins (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  weather    public.weather not null,
  note       text,
  local_hour smallint,                       -- 0..23 in the user's tz, for "your restless hour"
  created_at timestamptz not null default now()
);
create index if not exists idx_weather_user_time on public.weather_checkins (user_id, created_at desc);

-- Highlights / marginalia ---------------------------------------------------
-- line_hash normalises the quoted text so Resonance can aggregate the same line
-- across readers regardless of whitespace/case.
create table if not exists public.highlights (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  item_kind  public.content_kind not null,
  item_id    uuid not null,
  lang       text not null check (lang in ('en', 'hi')),
  quote      text not null,
  note       text,                            -- the margin note (optional)
  line_hash  text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_highlights_user on public.highlights (user_id, created_at desc);
create index if not exists idx_highlights_line on public.highlights (item_kind, item_id, line_hash);

create or replace function public.tg_highlight_line_hash()
returns trigger language plpgsql as $$
begin
  new.line_hash := encode(extensions.digest(lower(btrim(new.quote)), 'sha1'), 'hex');
  return new;
end $$;
create trigger highlight_line_hash before insert or update of quote on public.highlights
  for each row execute function public.tg_highlight_line_hash();

-- Reflections (the journal) -------------------------------------------------
-- sentiment / themes / embedding are filled asynchronously by the API after
-- insert; embedding feeds the Mirror and companion memory retrieval.
create table if not exists public.reflections (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  context    jsonb not null default '{}'::jsonb,  -- {kind,id} or {sit_id}
  lang       text not null default 'en' check (lang in ('en', 'hi')),
  text       text not null,
  sentiment  real,                                -- -1..1, AI-derived
  themes     text[] not null default '{}',
  embedding  extensions.vector(768),
  safety_severity smallint not null default 0,    -- 0 none .. 3 crisis
  created_at timestamptz not null default now()
);
create index if not exists idx_reflections_user on public.reflections (user_id, created_at desc);
create index if not exists idx_reflections_embedding
  on public.reflections using hnsw (embedding extensions.vector_cosine_ops);

-- Practices (the garden) ----------------------------------------------------
create table if not exists public.practices (
  id           bigint generated always as identity primary key,
  user_id      uuid not null,
  text         text not null,
  source_kind  public.content_kind,
  source_id    uuid,
  status       public.practice_status not null default 'active',
  kept_count   integer not null default 0,
  last_kept_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_practices_user on public.practices (user_id, status, created_at desc);
create trigger set_updated_at before update on public.practices
  for each row execute function public.tg_set_updated_at();

-- Saved shelf ---------------------------------------------------------------
create table if not exists public.saved_items (
  user_id    uuid not null,
  item_kind  public.content_kind not null,
  item_id    uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, item_kind, item_id)
);

-- Journey progress / continue-state ----------------------------------------
create table if not exists public.progress (
  user_id    uuid not null,
  item_kind  public.content_kind not null,
  item_id    uuid not null,
  position   jsonb not null default '{}'::jsonb,  -- {chapterSeq,totalChapters,audioSec,nextTitle}
  updated_at timestamptz not null default now(),
  primary key (user_id, item_kind, item_id)
);
create trigger set_updated_at before update on public.progress
  for each row execute function public.tg_set_updated_at();

-- Daily Sit -----------------------------------------------------------------
create table if not exists public.sits (
  id           bigint generated always as identity primary key,
  user_id      uuid not null,
  for_date     date not null,
  weather      public.weather,
  plan         jsonb not null,                    -- {arrive,read:{kind,id},reflect,carry}
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  unique (user_id, for_date)
);
create index if not exists idx_sits_user on public.sits (user_id, for_date desc);

-- Kitab combined setup: all migrations (0001-0009) + dev seed, in order.
-- Paste into Supabase Studio → SQL Editor → Run. Safe on a fresh project.
-- (Seed section is dev-only: it truncates ratings/item_stats/item_similarity.)


-- ======================================================================
-- migrations/0001_extensions.sql
-- ======================================================================
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

-- ======================================================================
-- migrations/0002_profiles.sql
-- ======================================================================
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

-- ======================================================================
-- migrations/0003_content_embeddings.sql
-- ======================================================================
-- 0003_content_embeddings.sql
-- pgvector index over the existing content (bites / journeys / summaries).
-- Powers: RAG page composition, "ask this line", and feeling-based discovery.
--
-- Content is chunked per language (heading / paragraph for bites & summaries,
-- chapter for journeys). The API backfill script (api/src/scripts) fills the
-- embeddings; this migration only defines the storage + indexes.

-- Unified, read-only view over the three content tables. One place to resolve a
-- polymorphic (kind, id) reference into display fields for joins & ranking.
create or replace view public.content_items as
  select 'byte'::public.content_kind as kind, b.id, b.title, b.author, b.cover,
         b.category,
         coalesce(b.tags::text, '') as tags_text,
         b.created_at
    from public.bites b
  union all
  select 'journey'::public.content_kind, j.id, j.title, j.author, j.cover,
         null::text,
         coalesce(j.tags::text, ''),
         j.created_at
    from public.journeys j
  union all
  select 'summary'::public.content_kind, s.id, s.title, s.author, s.cover,
         null::text,
         coalesce(s.tags::text, ''),
         s.created_at
    from public.summaries s;

create table if not exists public.content_chunks (
  id           bigint generated always as identity primary key,
  item_kind    public.content_kind not null,
  item_id      uuid not null,
  lang         text not null check (lang in ('en', 'hi')),
  chunk_index  integer not null,
  heading      text,
  text         text not null,
  token_estimate integer,
  content_hash text not null,                 -- idempotent backfill: skip if unchanged
  embedding    extensions.vector(768),
  created_at   timestamptz not null default now(),
  unique (item_kind, item_id, lang, chunk_index)
);

create index if not exists idx_chunks_item on public.content_chunks (item_kind, item_id, lang);

-- HNSW = fast approximate NN with high recall, ideal for read-heavy retrieval.
-- Build after the backfill for best graph quality; cosine matches normalised
-- embeddings. m/ef_construction tuned for a few-thousand-chunk corpus.
create index if not exists idx_chunks_embedding
  on public.content_chunks using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Incremental re-embedding queue. A trigger enqueues changed content; the worker
-- drains it. Keeps embeddings eventually-consistent without a full rebuild.
create table if not exists public.content_embedding_queue (
  item_kind   public.content_kind not null,
  item_id     uuid not null,
  enqueued_at timestamptz not null default now(),
  attempts    integer not null default 0,
  primary key (item_kind, item_id)
);

create or replace function public.tg_enqueue_content_embedding()
returns trigger language plpgsql as $$
declare k public.content_kind;
begin
  k := case tg_table_name
         when 'bites' then 'byte'::public.content_kind
         when 'journeys' then 'journey'::public.content_kind
         when 'summaries' then 'summary'::public.content_kind
       end;
  insert into public.content_embedding_queue (item_kind, item_id)
  values (k, new.id)
  on conflict (item_kind, item_id)
    do update set enqueued_at = now(), attempts = 0;
  return new;
end $$;

create trigger enqueue_embed_bites     after insert or update of content on public.bites
  for each row execute function public.tg_enqueue_content_embedding();
create trigger enqueue_embed_journeys  after insert or update of content, content_chapterwise on public.journeys
  for each row execute function public.tg_enqueue_content_embedding();
create trigger enqueue_embed_summaries after insert or update of content on public.summaries
  for each row execute function public.tg_enqueue_content_embedding();

-- ======================================================================
-- migrations/0004_engagement.sql
-- ======================================================================
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

-- ======================================================================
-- migrations/0005_social_cf.sql
-- ======================================================================
-- 0005_social_cf.sql
-- Social signal + collaborative filtering. Ratings are dummy-seeded (see seed/),
-- item_stats is a maintained rollup, and item_similarity is item-item CF derived
-- from co-ratings. Recommendations blend CF + popularity + weather-fit.

-- Synthetic users for CF dummy data. Decoupled from auth.users on purpose so the
-- interaction log can carry both real and fake users without FK contortions.
create table if not exists public.synthetic_users (
  id      uuid primary key default extensions.gen_random_uuid(),
  persona text,
  created_at timestamptz not null default now()
);

create table if not exists public.ratings (
  user_id    uuid not null,
  item_kind  public.content_kind not null,
  item_id    uuid not null,
  rating     smallint not null check (rating between 1 and 5),
  created_at timestamptz not null default now(),
  primary key (user_id, item_kind, item_id)
);
create index if not exists idx_ratings_item on public.ratings (item_kind, item_id);

-- Per-item rollup. Hot-row updates are fine at current scale; the documented
-- scale path is a periodic aggregate or a Redis counter (ARCHITECTURE.md).
create table if not exists public.item_stats (
  item_kind     public.content_kind not null,
  item_id       uuid not null,
  opens         bigint not null default 0,
  completes     bigint not null default 0,
  saves         bigint not null default 0,
  rating_sum    bigint not null default 0,
  rating_count  bigint not null default 0,
  avg_rating    real generated always as
                  (case when rating_count > 0 then rating_sum::real / rating_count else 0 end) stored,
  completion_rate real generated always as
                  (case when opens > 0 then completes::real / opens else 0 end) stored,
  updated_at    timestamptz not null default now(),
  primary key (item_kind, item_id)
);

-- Item-item similarity (top-N neighbours per item). Recomputed offline.
create table if not exists public.item_similarity (
  item_kind_a public.content_kind not null,
  item_id_a   uuid not null,
  item_kind_b public.content_kind not null,
  item_id_b   uuid not null,
  score       real not null,
  primary key (item_kind_a, item_id_a, item_kind_b, item_id_b)
);
create index if not exists idx_item_sim_a on public.item_similarity (item_kind_a, item_id_a, score desc);

-- ======================================================================
-- migrations/0006_ai_artifacts.sql
-- ======================================================================
-- 0006_ai_artifacts.sql
-- Generated, cached AI outputs + the companion's editable memory. These are
-- written by the API (service role). Memory is user-visible and editable by
-- design — transparency is the trust + switching-cost moat.

-- The Mirror: a weekly self-portrait snapshot. History is kept so the
-- "week 1 -> now" delta is a row diff, not a recomputation.
create table if not exists public.mirror_snapshots (
  id           bigint generated always as identity primary key,
  user_id      uuid not null,
  week_start   date not null,
  portrait     text not null,
  traits       jsonb not null default '{}'::jsonb,   -- {steadiness:0.6, ...}
  deltas       jsonb not null default '{}'::jsonb,   -- vs first snapshot
  source_window jsonb not null default '{}'::jsonb,  -- counts the portrait was built from
  model        text,
  generated_at timestamptz not null default now(),
  unique (user_id, week_start)
);
create index if not exists idx_mirror_user on public.mirror_snapshots (user_id, week_start desc);

-- The weekly letter from Kitab.
create table if not exists public.letters (
  id           bigint generated always as identity primary key,
  user_id      uuid not null,
  week_start   date not null,
  lang         text not null default 'en' check (lang in ('en', 'hi')),
  body         text not null,
  model        text,
  generated_at timestamptz not null default now(),
  unique (user_id, week_start, lang)
);

-- Companion memory: small, retrievable, editable facts about the user.
create table if not exists public.memories (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  kind       public.memory_kind not null default 'fact',
  text       text not null,
  embedding  extensions.vector(768),
  salience   real not null default 0.5,           -- decays over time; pin to protect
  source     jsonb not null default '{}'::jsonb,  -- {event_id} / {reflection_id}
  is_visible boolean not null default true,       -- shown in the editable memory UI
  is_pinned  boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_memories_user on public.memories (user_id, salience desc);
create index if not exists idx_memories_embedding
  on public.memories using hnsw (embedding extensions.vector_cosine_ops);
create trigger set_updated_at before update on public.memories
  for each row execute function public.tg_set_updated_at();

-- Becoming arcs (content) + enrollment (per user) --------------------------
create table if not exists public.arcs (
  id          bigint generated always as identity primary key,
  slug        text unique not null,
  title       jsonb not null,                      -- {en,hi}
  subtitle    jsonb not null default '{}'::jsonb,
  total_steps integer not null,
  goal_weather public.weather,                     -- the state this arc moves toward
  created_at  timestamptz not null default now()
);

create table if not exists public.arc_steps (
  arc_id     bigint not null references public.arcs (id) on delete cascade,
  step_index integer not null,
  title      jsonb not null,
  item_kind  public.content_kind,
  item_id    uuid,
  prompt     jsonb not null default '{}'::jsonb,    -- reflection prompt for the step
  primary key (arc_id, step_index)
);

create table if not exists public.user_arcs (
  user_id      uuid not null,
  arc_id       bigint not null references public.arcs (id) on delete cascade,
  current_step integer not null default 0,
  started_at   timestamptz not null default now(),
  completed_at timestamptz,
  primary key (user_id, arc_id)
);

-- Safety: distress detection audit trail. Written when the classifier fires.
create table if not exists public.safety_flags (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  source     text not null,                        -- 'reflection' | 'voice' | 'ask'
  severity   smallint not null,                    -- 1 mild .. 3 crisis
  signals    jsonb not null default '{}'::jsonb,
  action     text,                                 -- 'resources_shown' | 'handoff'
  created_at timestamptz not null default now()
);
create index if not exists idx_safety_user on public.safety_flags (user_id, created_at desc);

-- ======================================================================
-- migrations/0007_triggers.sql
-- ======================================================================
-- 0007_triggers.sql
-- Counters are maintained from the event stream so the write path stays a single
-- INSERT and reads never aggregate the raw log on the hot path.

-- Maintain item_stats from events (open / complete / save / unsave).
create or replace function public.tg_events_rollup()
returns trigger language plpgsql as $$
begin
  if new.item_id is null or new.item_kind is null then
    return new;
  end if;

  insert into public.item_stats (item_kind, item_id, opens, completes, saves, updated_at)
  values (
    new.item_kind, new.item_id,
    case when new.type = 'page_open' then 1 else 0 end,
    case when new.type in ('page_complete', 'listen_complete') then 1 else 0 end,
    case when new.type = 'save' then 1 else 0 end,
    now()
  )
  on conflict (item_kind, item_id) do update set
    opens     = public.item_stats.opens     + excluded.opens,
    completes = public.item_stats.completes + excluded.completes,
    saves     = public.item_stats.saves
                + excluded.saves
                - case when new.type = 'unsave' then 1 else 0 end,
    updated_at = now();

  return new;
end $$;

create trigger events_rollup after insert on public.events
  for each row execute function public.tg_events_rollup();

-- Maintain profile activity (days_used = distinct active days) cheaply.
create or replace function public.tg_events_touch_profile()
returns trigger language plpgsql
security definer set search_path = public as $$
begin
  update public.profiles p
     set last_active_at = now(),
         days_used = p.days_used + case
           when p.last_active_at is null
             or (p.last_active_at at time zone p.timezone)::date
                < (now() at time zone p.timezone)::date
           then 1 else 0 end
   where p.id = new.user_id;
  return new;
end $$;

create trigger events_touch_profile after insert on public.events
  for each row execute function public.tg_events_touch_profile();

-- Maintain rating rollup in item_stats.
create or replace function public.tg_ratings_rollup()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into public.item_stats (item_kind, item_id, rating_sum, rating_count, updated_at)
    values (new.item_kind, new.item_id, new.rating, 1, now())
    on conflict (item_kind, item_id) do update set
      rating_sum   = public.item_stats.rating_sum + new.rating,
      rating_count = public.item_stats.rating_count + 1,
      updated_at   = now();
  elsif tg_op = 'UPDATE' then
    update public.item_stats set
      rating_sum = rating_sum - old.rating + new.rating,
      updated_at = now()
    where item_kind = new.item_kind and item_id = new.item_id;
  end if;
  return new;
end $$;

create trigger ratings_rollup after insert or update of rating on public.ratings
  for each row execute function public.tg_ratings_rollup();

-- ======================================================================
-- migrations/0008_functions.sql
-- ======================================================================
-- 0008_functions.sql
-- RPC surface. Read-heavy screens get one round trip; vector search and CF run
-- next to the data. Functions that touch user rows run SECURITY INVOKER so RLS
-- applies; cross-user aggregates run SECURITY DEFINER and return only anonymised
-- shapes.

-- ---------------------------------------------------------------------------
-- RAG retrieval: nearest content chunks to a query embedding.
-- ---------------------------------------------------------------------------
create or replace function public.vector_search_content(
  query_embedding extensions.vector,
  p_lang text default 'en',
  match_count integer default 8,
  p_kinds public.content_kind[] default null
)
returns table (
  item_kind public.content_kind,
  item_id   uuid,
  lang      text,
  chunk_index integer,
  heading   text,
  text      text,
  similarity real
)
language sql stable
set search_path = public, extensions
as $$
  select c.item_kind, c.item_id, c.lang, c.chunk_index, c.heading, c.text,
         (1 - (c.embedding <=> query_embedding))::real as similarity
  from public.content_chunks c
  where c.embedding is not null
    and c.lang = p_lang
    and (p_kinds is null or c.item_kind = any (p_kinds))
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- ---------------------------------------------------------------------------
-- Feeling-based discovery: search items (not chunks) by meaning.
-- Pull top chunks via the HNSW index, then collapse to best chunk per item.
-- ---------------------------------------------------------------------------
create or replace function public.search_items_by_feeling(
  query_embedding extensions.vector,
  p_lang text default 'en',
  match_count integer default 10
)
returns table (
  kind public.content_kind,
  id uuid,
  title text,
  author text,
  cover text,
  similarity real
)
language sql stable
set search_path = public, extensions
as $$
  with near as (
    select c.item_kind, c.item_id,
           (1 - (c.embedding <=> query_embedding))::real as sim
    from public.content_chunks c
    where c.embedding is not null and c.lang = p_lang
    order by c.embedding <=> query_embedding
    limit match_count * 5
  ),
  best as (
    select item_kind, item_id, max(sim) as similarity
    from near group by item_kind, item_id
    order by similarity desc
    limit match_count
  )
  select ci.kind, ci.id, ci.title, ci.author, ci.cover, b.similarity
  from best b
  join public.content_items ci on ci.kind = b.item_kind and ci.id = b.item_id
  order by b.similarity desc;
$$;

-- ---------------------------------------------------------------------------
-- Recommendations: item-item CF blended with popularity + weather fit.
-- SECURITY DEFINER so it can read other users' stats; returns items only.
-- ---------------------------------------------------------------------------
create or replace function public.recommend_for_user(
  p_user uuid,
  p_weather public.weather default null,
  p_limit integer default 10
)
returns table (
  kind public.content_kind,
  id uuid,
  title text,
  author text,
  cover text,
  score real,
  reason text
)
language sql stable
security definer
set search_path = public, extensions
as $$
  with seen as (
    select item_kind k, item_id i from public.saved_items where user_id = p_user
    union
    select item_kind, item_id from public.events
      where user_id = p_user and type in ('page_complete', 'listen_complete') and item_id is not null
    union
    select item_kind, item_id from public.ratings where user_id = p_user
  ),
  seeds as (  -- things the user liked, used as CF anchors
    select item_kind k, item_id i from public.saved_items where user_id = p_user
    union
    select item_kind, item_id from public.ratings where user_id = p_user and rating >= 4
    union
    select item_kind, item_id from public.events
      where user_id = p_user and type in ('page_complete', 'listen_complete')
        and item_id is not null and created_at > now() - interval '120 days'
  ),
  cf as (  -- neighbours of the seeds
    select s.item_kind_b k, s.item_id_b i, sum(s.score) as cf_score
    from seeds sd
    join public.item_similarity s
      on s.item_kind_a = sd.k and s.item_id_a = sd.i
    group by 1, 2
  ),
  pop as (  -- normalised popularity prior
    select item_kind k, item_id i,
           (0.6 * least(avg_rating / 5.0, 1) + 0.4 * completion_rate)::real as pop_score
    from public.item_stats
  ),
  candidates as (
    select ci.kind k, ci.id i, ci.title, ci.author, ci.cover, ci.category, ci.tags_text,
           coalesce(cf.cf_score, 0)  as cf_score,
           coalesce(pop.pop_score, 0) as pop_score
    from public.content_items ci
    left join cf  on cf.k  = ci.kind and cf.i  = ci.id
    left join pop on pop.k = ci.kind and pop.i = ci.id
    where not exists (select 1 from seen where seen.k = ci.kind and seen.i = ci.id)
  ),
  scored as (
    select *,
      -- normalise cf within this candidate set; popularity already 0..1
      case when max(cf_score) over () > 0 then cf_score / max(cf_score) over () else 0 end as cf_norm,
      -- weather fit: bias toward calming content when the user is heavy/restless
      case when p_weather in ('heavy', 'restless')
             and (coalesce(category,'') || ' ' || tags_text)
                 ~* '(calm|sleep|breath|mindful|rest|peace|still|anx)'
           then 1.0 else 0.0 end as weather_boost
    from candidates
  )
  select k, i, title, author, cover,
         (0.6 * cf_norm + 0.3 * pop_score + 0.1 * weather_boost)::real as score,
         case
           when cf_norm > 0 and weather_boost > 0 then 'because of what you''ve loved · fits tonight'
           when cf_norm > 0 then 'readers like you returned to this'
           when weather_boost > 0 then 'gentle for how tonight feels'
           else 'loved across Kitab'
         end as reason
  from scored
  order by score desc, pop_score desc
  limit p_limit;
$$;

-- ---------------------------------------------------------------------------
-- Resonance: how many readers underlined this line + a few anonymised notes.
-- ---------------------------------------------------------------------------
create or replace function public.get_resonance(
  p_kind public.content_kind,
  p_item uuid,
  p_line_hash text,
  p_samples integer default 3
)
returns jsonb
language sql stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'count', (select count(*) from public.highlights
               where item_kind = p_kind and item_id = p_item and line_hash = p_line_hash),
    'samples', coalesce((
      select jsonb_agg(jsonb_build_object('note', note, 'lang', lang))
      from (
        select note, lang from public.highlights
        where item_kind = p_kind and item_id = p_item and line_hash = p_line_hash
          and note is not null and length(btrim(note)) > 0
        order by created_at desc
        limit p_samples
      ) s
    ), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- Garden summary (felt-progress screen).
-- ---------------------------------------------------------------------------
create or replace function public.garden_summary(p_user uuid)
returns jsonb
language sql stable
set search_path = public
as $$
  select jsonb_build_object(
    'practices_kept', coalesce((select sum(kept_count) from public.practices where user_id = p_user), 0),
    'pages_read',     (select count(distinct (item_kind, item_id)) from public.events
                         where user_id = p_user and type in ('page_complete','listen_complete')),
    'days_used',      coalesce((select days_used from public.profiles where id = p_user), 0),
    'leaves', coalesce((
      select jsonb_agg(jsonb_build_object('text', text, 'kept', kept_count, 'status', status))
      from (select text, kept_count, status from public.practices
            where user_id = p_user order by last_kept_at desc nulls last, created_at desc limit 30) p
    ), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- Weather trend (one point per day, latest check-in wins).
-- ---------------------------------------------------------------------------
create or replace function public.weather_trend(p_user uuid, p_days integer default 14)
returns table (day date, weather public.weather, score smallint)
language sql stable
set search_path = public
as $$
  select day, weather,
         (array_position(array['heavy','restless','cloudy','clear','bright']::text[], weather::text) - 1)::smallint
  from (
    select distinct on (created_at::date)
           created_at::date as day, weather
    from public.weather_checkins
    where user_id = p_user and created_at > now() - make_interval(days => p_days)
    order by created_at::date desc, created_at desc
  ) t
  order by day;
$$;

-- ---------------------------------------------------------------------------
-- Home screen in one round trip.
-- ---------------------------------------------------------------------------
create or replace function public.get_home(p_user uuid)
returns jsonb
language sql stable
set search_path = public
as $$
  select jsonb_build_object(
    'continue', (
      select jsonb_build_object('kind', pr.item_kind, 'id', pr.item_id,
                                'position', pr.position, 'updated_at', pr.updated_at)
      from public.progress pr
      where pr.user_id = p_user and pr.item_kind = 'journey'
      order by pr.updated_at desc limit 1
    ),
    'saved_count', (select count(*) from public.saved_items where user_id = p_user),
    'garden', public.garden_summary(p_user),
    'weather_recent', coalesce((
      select jsonb_agg(jsonb_build_object('day', day, 'weather', weather, 'score', score))
      from public.weather_trend(p_user, 7)
    ), '[]'::jsonb),
    'has_sit_today', exists (
      select 1 from public.sits
      where user_id = p_user and for_date = (now() at time zone
        coalesce((select timezone from public.profiles where id = p_user), 'UTC'))::date
    )
  );
$$;

-- ---------------------------------------------------------------------------
-- Writes (SECURITY INVOKER → RLS enforces ownership via auth.uid()).
-- ---------------------------------------------------------------------------
create or replace function public.log_event(
  p_type public.event_type,
  p_kind public.content_kind default null,
  p_item uuid default null,
  p_payload jsonb default '{}'::jsonb
)
returns bigint
language sql
set search_path = public
as $$
  insert into public.events (user_id, type, item_kind, item_id, payload)
  values (auth.uid(), p_type, p_kind, p_item, p_payload)
  returning id;
$$;

create or replace function public.keep_practice(p_practice bigint)
returns void
language plpgsql
set search_path = public
as $$
begin
  update public.practices
     set kept_count = kept_count + 1, last_kept_at = now(), status = 'kept'
   where id = p_practice and user_id = auth.uid();
  insert into public.events (user_id, type, payload)
  values (auth.uid(), 'practice_kept', jsonb_build_object('practice_id', p_practice));
end $$;

create or replace function public.toggle_saved(p_kind public.content_kind, p_item uuid)
returns boolean
language plpgsql
set search_path = public
as $$
declare existed boolean;
begin
  delete from public.saved_items
   where user_id = auth.uid() and item_kind = p_kind and item_id = p_item;
  get diagnostics existed = row_count;
  if existed then
    insert into public.events (user_id, type, item_kind, item_id) values (auth.uid(), 'unsave', p_kind, p_item);
    return false;
  else
    insert into public.saved_items (user_id, item_kind, item_id) values (auth.uid(), p_kind, p_item);
    insert into public.events (user_id, type, item_kind, item_id) values (auth.uid(), 'save', p_kind, p_item);
    return true;
  end if;
end $$;

create or replace function public.upsert_progress(p_kind public.content_kind, p_item uuid, p_position jsonb)
returns void
language sql
set search_path = public
as $$
  insert into public.progress (user_id, item_kind, item_id, position)
  values (auth.uid(), p_kind, p_item, p_position)
  on conflict (user_id, item_kind, item_id)
    do update set position = excluded.position, updated_at = now();
$$;

create or replace function public.enroll_arc(p_slug text)
returns bigint
language plpgsql
set search_path = public
as $$
declare v_arc bigint;
begin
  select id into v_arc from public.arcs where slug = p_slug;
  if v_arc is null then raise exception 'arc % not found', p_slug; end if;
  insert into public.user_arcs (user_id, arc_id) values (auth.uid(), v_arc)
  on conflict (user_id, arc_id) do nothing;
  insert into public.events (user_id, type, payload) values (auth.uid(), 'arc_enroll', jsonb_build_object('arc_id', v_arc));
  return v_arc;
end $$;

create or replace function public.advance_arc(p_arc bigint)
returns integer
language plpgsql
set search_path = public
as $$
declare v_step integer; v_total integer;
begin
  select total_steps into v_total from public.arcs where id = p_arc;
  update public.user_arcs
     set current_step = least(current_step + 1, v_total),
         completed_at = case when current_step + 1 >= v_total then now() else completed_at end
   where user_id = auth.uid() and arc_id = p_arc
   returning current_step into v_step;
  insert into public.events (user_id, type, payload)
  values (auth.uid(), 'arc_advance', jsonb_build_object('arc_id', p_arc, 'step', v_step));
  return v_step;
end $$;

-- ======================================================================
-- migrations/0009_rls.sql
-- ======================================================================
-- 0009_rls.sql
-- Row Level Security. Default-deny: enable RLS everywhere, then grant the
-- narrowest workable policy. The service-role key (API server) bypasses RLS,
-- so cross-user work (CF, resonance, generating artifacts) happens there.
--
-- Pattern for owned tables: a single FOR ALL policy keyed on auth.uid().

-- Owned-by-user tables -----------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'weather_checkins','highlights','reflections','practices',
    'saved_items','progress','sits','ratings','user_arcs',
    'mirror_snapshots','letters','memories','safety_flags','events'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists own_rows on public.%I;', t);
    execute format($p$create policy own_rows on public.%I
        for all to authenticated
        using (user_id = (select auth.uid()))
        with check (user_id = (select auth.uid()));$p$, t);
  end loop;
end $$;

-- profiles: keyed on id, not user_id.
alter table public.profiles enable row level security;
drop policy if exists own_profile on public.profiles;
create policy own_profile on public.profiles
  for all to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Read-only public reference data (content + aggregates). Anyone signed in (and
-- anon, for the discover/catalog screens) may read; only the service role writes.
do $$
declare t text;
begin
  foreach t in array array[
    'content_chunks','item_stats','item_similarity','arcs','arc_steps'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists read_all on public.%I;', t);
    execute format($p$create policy read_all on public.%I
        for select to authenticated, anon using (true);$p$, t);
  end loop;
end $$;

-- Resonance reads happen through get_resonance() (SECURITY DEFINER), so the
-- highlights table itself stays owner-only — a reader can never enumerate
-- another user's marginalia, only the anonymised aggregate.

-- The existing content tables (bites/journeys/summaries) keep their current
-- public-read posture managed by the app's Supabase project; not re-declared here.

-- Synthetic users + queues are service-role only (RLS on, no policy = deny).
alter table public.synthetic_users        enable row level security;
alter table public.content_embedding_queue enable row level security;

-- ======================================================================
-- seed/seed.sql
-- ======================================================================
-- seed.sql — DEV seed. Idempotent: truncates the synthetic/derived tables and
-- rebuilds them. Safe to re-run on a dev DB. Do NOT run against prod (it clears
-- ratings/item_stats). Generates dummy users + ratings, derives popularity and
-- real item-item collaborative filtering from co-ratings, and seeds two arcs.
--
-- References whatever content actually exists in bites/journeys/summaries, so it
-- adapts to the live catalog.

select setseed(0.42);  -- deterministic randomness for reproducible seeds

truncate table public.item_similarity;
truncate table public.item_stats;
truncate table public.ratings;
delete from public.events where user_id in (select id from public.synthetic_users);
delete from public.arc_steps; delete from public.arcs;
truncate table public.synthetic_users cascade;

-- 1) 40 synthetic users -----------------------------------------------------
insert into public.synthetic_users (persona)
select 'persona_' || g from generate_series(1, 40) g;

-- 2) Ratings: each synthetic user rates a random ~18% of the catalog, skewed
--    positive (people mostly rate things they liked). -----------------------
insert into public.ratings (user_id, item_kind, item_id, rating, created_at)
select su.id, ci.kind, ci.id,
       (case
          when random() < 0.65 then 5
          when random() < 0.85 then 4
          when random() < 0.95 then 3
          else 2
        end)::smallint,
       now() - make_interval(days => (random() * 90)::int)
from public.synthetic_users su
cross join public.content_items ci
where random() < 0.18
on conflict (user_id, item_kind, item_id) do nothing;
-- (item_stats rating_sum/rating_count are now populated by the ratings trigger.)

-- 3) Popularity priors: synthetic opens/completes for every item, derived
--    deterministically from the id so it's stable across re-seeds. ----------
insert into public.item_stats (item_kind, item_id, opens, completes)
select ci.kind, ci.id,
       (60 + (abs(hashtext(ci.id::text)) % 900))::bigint as opens,
       0::bigint
from public.content_items ci
on conflict (item_kind, item_id) do update
  set opens = excluded.opens;

update public.item_stats s
   set completes = floor(s.opens * (0.30 + (abs(hashtext(s.item_id::text || 'c')) % 55) / 100.0))::bigint;

-- 4) Item-item collaborative filtering from co-ratings.
--    cosine-style: co(a,b) / sqrt(|a| * |b|), keep top 20 neighbours / item.
with liked as (
  select user_id, item_kind k, item_id i from public.ratings where rating >= 4
),
pairs as (
  select a.k ka, a.i ia, b.k kb, b.i ib, count(*)::real co
  from liked a
  join liked b on a.user_id = b.user_id and (a.k, a.i) <> (b.k, b.i)
  group by 1, 2, 3, 4
  having count(*) >= 2
),
norms as (select k, i, count(*)::real c from liked group by 1, 2),
scored as (
  select p.ka, p.ia, p.kb, p.ib, (p.co / sqrt(na.c * nb.c))::real score
  from pairs p
  join norms na on na.k = p.ka and na.i = p.ia
  join norms nb on nb.k = p.kb and nb.i = p.ib
),
ranked as (
  select *, row_number() over (partition by ka, ia order by score desc) rn from scored
)
insert into public.item_similarity (item_kind_a, item_id_a, item_kind_b, item_id_b, score)
select ka, ia, kb, ib, score from ranked where rn <= 20
on conflict do nothing;

-- 5) Two Becoming arcs, steps drawn from the live catalog. ------------------
insert into public.arcs (slug, title, subtitle, total_steps, goal_weather)
values
  ('restless-to-still',
   '{"en":"From restless to still","hi":"बेचैनी से शांति की ओर"}'::jsonb,
   '{"en":"21 evenings","hi":"21 शामें"}'::jsonb, 21, 'clear'),
  ('morning-clarity',
   '{"en":"Morning clarity","hi":"सुबह की स्पष्टता"}'::jsonb,
   '{"en":"14 mornings","hi":"14 सुबह"}'::jsonb, 14, 'bright');

-- Step content for the first arc, drawn from the live catalog (calming first).
with picks as (
  select kind, id,
         row_number() over (
           order by (case when (coalesce(category,'') || ' ' || tags_text)
                            ~* '(calm|breath|mindful|sleep|peace|still|rest)' then 0 else 1 end),
                    kind, id) rn
  from public.content_items
)
insert into public.arc_steps (arc_id, step_index, title, item_kind, item_id, prompt)
select a.id, p.rn,
       jsonb_build_object('en', 'Evening ' || p.rn),
       p.kind, p.id,
       '{"en":"What settled tonight?"}'::jsonb
from public.arcs a
join (select kind, id, rn from picks where rn <= 5) p on a.slug = 'restless-to-still';

-- Quick sanity counts (visible in the migration/seed output).
do $$
declare r record;
begin
  for r in
    select 'synthetic_users' t, count(*) n from public.synthetic_users
    union all select 'ratings', count(*) from public.ratings
    union all select 'item_stats', count(*) from public.item_stats
    union all select 'item_similarity', count(*) from public.item_similarity
    union all select 'arcs', count(*) from public.arcs
  loop
    raise notice 'seed: % = %', r.t, r.n;
  end loop;
end $$;

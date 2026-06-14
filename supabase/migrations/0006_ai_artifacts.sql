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

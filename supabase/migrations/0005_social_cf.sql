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

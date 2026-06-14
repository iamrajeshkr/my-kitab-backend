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

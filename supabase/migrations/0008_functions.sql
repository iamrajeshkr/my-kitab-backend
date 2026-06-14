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

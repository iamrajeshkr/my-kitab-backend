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

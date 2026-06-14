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

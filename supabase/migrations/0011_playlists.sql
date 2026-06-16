-- 0011_playlists.sql
-- Saved collections ("playlists"). A user has many named playlists; each holds
-- content items. Highlights/commonplace are a separate, already-existing thing
-- surfaced alongside these in the Saved tab.

create table if not exists public.playlists (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  name       text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_playlists_user on public.playlists (user_id, created_at desc);

create table if not exists public.playlist_items (
  playlist_id bigint not null references public.playlists(id) on delete cascade,
  item_kind   public.content_kind not null,
  item_id     uuid not null,
  created_at  timestamptz not null default now(),
  primary key (playlist_id, item_kind, item_id)
);
create index if not exists idx_playlist_items_recent on public.playlist_items (playlist_id, created_at desc);

-- RLS: playlists are owner-only; playlist_items inherit ownership via the parent.
alter table public.playlists enable row level security;
drop policy if exists own_rows on public.playlists;
create policy own_rows on public.playlists
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter table public.playlist_items enable row level security;
drop policy if exists own_via_playlist on public.playlist_items;
create policy own_via_playlist on public.playlist_items
  for all to authenticated
  using (exists (select 1 from public.playlists p where p.id = playlist_id and p.user_id = (select auth.uid())))
  with check (exists (select 1 from public.playlists p where p.id = playlist_id and p.user_id = (select auth.uid())));

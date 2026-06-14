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

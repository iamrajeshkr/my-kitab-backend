# Kitab backend — architecture

## The two planes

```
Expo app ──jwt──▶ API (Hono, stateless)      ──service key──▶ ┐
   │                 • RAG page composition                    │
   │                 • ask-this-line, Mirror, letter, sit      │
   │                 • embeddings, safety classifier           │
   │                 • LLM keys live ONLY here                 ▼
   └──────────────jwt (RLS)──────────────────────────▶  Supabase Postgres
                                                          • tables + RLS
                                                          • RPC (1 round trip / screen)
                                                          • pgvector (HNSW)
                                                          • triggers maintain counters
```

- **Data plane = Postgres.** Source of truth. Read-heavy screens load via a single
  RPC (`get_home`, `garden_summary`, `recommend_for_user`). Vector search and
  collaborative filtering run *next to the data* — no network hop, no data egress.
- **Control plane = the API.** Stateless, horizontally scalable. Owns everything
  that touches an LLM. This is also the fix for the Expo client shipping the Gemini
  key: keys never leave the server.

## Why these choices

| Decision | Why | Scale path |
|---|---|---|
| Reuse Supabase Postgres | Content already lives there; ships pgvector + RLS + PostgREST | Read replicas; PgBouncer (already on Supabase) |
| Append-only `events` + trigger-maintained `item_stats` | Single-INSERT writes; reads never aggregate the raw log | Monthly RANGE partitioning; move hot counters to Redis/`pg_stat` rollup |
| BRIN on `events.created_at` | Tiny index, ideal for append-only time series | Partition pruning once partitioned |
| HNSW pgvector index, cosine | Fast approximate-NN, high recall for read-heavy retrieval | Tune `m`/`ef_search`; shard by lang if corpus explodes |
| RLS everywhere, `auth.uid()` | Defence in depth — an API bug still can't cross users | — |
| Local JWT verify (`jose`, HS256) | No auth round trip on the hot path | Rotate via `SUPABASE_JWT_SECRET` |
| Structured output (`generateText` + `Output.object`) | Typed, schema-validated, model retries on bad output | — |
| Grounding contract (cite chunk ids, validate server-side) | The AI interprets *real* corpus, never invents wisdom | Add a reranker before compose |

## Auth model (no Supabase Auth)

The backend owns identity. `POST /v1/auth/guest` upserts a `profiles` row keyed
on a stable anonymous `device_id` and mints a JWT signed with the project JWT
secret (`sub = profiles.id`, `role = authenticated`). PostgREST validates that
signature and RLS resolves `auth.uid()` to the user — so there's no signup,
email, or verification flow, yet per-user isolation is fully enforced. Email can
be linked later to move a guest off one device. `profiles` has no FK to
`auth.users` (which is unused).

## Security model

- **Owned tables** (events, reflections, highlights, practices, …) — RLS `user_id = auth.uid()`.
  The API uses the caller's JWT (`userClient`) so PostgREST enforces it.
- **Cross-user work** (CF, resonance, generating artifacts, backfill) — runs through
  `SECURITY DEFINER` RPCs that return only anonymised shapes, or the service-role
  client in the API. A reader can get resonance *counts + anonymous notes* for a
  line, never another user's marginalia.
- **Synthetic users** for CF dummy data are decoupled from `auth.users`; the
  interaction log carries a bare `user_id uuid` so real and fake users coexist
  without FK contortions.

## Latency budget (typical)

- Pure data screens (home, garden, discover): one RPC, single-digit ms in-region.
- Recommendations: one CF RPC, indexed; no LLM.
- `compose-page` / `ask-line`: 1 embed + 1 vector RPC + 1 LLM call. Stream the LLM;
  cache composed pages per `(user, date, weather)` (Vercel Runtime Cache / Redis).
- Reflections: persist first (fast 200), enrich (embed + analysis + safety) after —
  the user never waits on the LLM to save their words.

## What runs on a schedule (cron)

- `mirror/generate` — weekly per active user.
- `letter/generate` — Sunday per active user.
- `backfill-embeddings` — drains `content_embedding_queue` (trigger-enqueued on
  content edits); `--all` for a full rebuild.
- `item_similarity` recompute — offline from co-ratings (see `seed.sql` query).

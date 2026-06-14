# Kitab backend

Two pieces:

- `supabase/` — the **data plane**: migrations (schema, RLS, RPCs, pgvector) + a dev seed.
- `api/` — the **control plane**: a stateless Hono service for all AI/LLM work
  (RAG composition, ask-this-line, the Mirror, weekly letter, daily sit,
  embeddings, recommendations, safety). LLM keys live only here.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the why.

## 1. Database

Apply the migrations in order against your Supabase project (Studio SQL editor,
`psql`, or `supabase db push`), then seed dummy data for dev:

```bash
# with the Supabase CLI linked to your project
supabase db push                      # runs supabase/migrations/*.sql in order
psql "$DATABASE_URL" -f supabase/seed/seed.sql   # dummy users, ratings, CF, arcs
```

The seed is idempotent (re-runnable) and **dev-only** — it truncates ratings /
item_stats / item_similarity. It references whatever content already exists in
`bites` / `journeys` / `summaries`, so it adapts to your live catalog.

## 2. API

```bash
cd api
cp .env.example .env        # fill in Supabase + Gemini keys
npm install
npm run backfill -- --all   # embed all content into content_chunks (one-off)
npm run dev                 # http://localhost:8787
```

### Endpoints (all under `/v1`, Bearer JWT required)

| Method | Path | Purpose |
|---|---|---|
| POST | `/compose-page` | Write tonight's page (RAG) + return cited sources |
| POST | `/ask-line` | Answer a question about a highlighted line, grounded |
| POST | `/reflections` | Store a reflection; enrich (sentiment/themes/memory/safety) |
| POST | `/recommend` | CF + popularity + weather-fit recommendations |
| POST | `/search` | Feeling-based semantic discovery |
| POST | `/events` | Batched event ingest |
| GET / POST | `/mirror` · `/mirror/generate` | The evolving self-portrait |
| GET / POST | `/letter` · `/letter/generate` | Weekly letter from Kitab |
| POST | `/sit` | Today's six-minute Daily Sit plan |

`GET /health` is unauthenticated.

## What the client must change

The Expo app currently calls Supabase and Gemini directly with `EXPO_PUBLIC_*`
keys. Migration:

1. Drop `EXPO_PUBLIC_GEMINI_API_KEY` — Gemini is server-side now. Replace the
   `askKitab` call in `src/lib/gemini.ts` with a POST to `/v1/recommend` or
   `/v1/compose-page`.
2. On first launch, generate a stable `device_id`, POST it to `/v1/auth/guest`,
   store the returned `{ userId, token }`, and send `Authorization: Bearer <token>`
   on every request. No Supabase Auth, no email/verification — the backend mints
   the token itself (`src/lib/token.ts`); RLS still enforces per-user isolation.
   (Email linking can be added later to move a guest off a single device.)
3. Move the local `prefs`/`saved` state to the synced tables (`profiles`,
   `saved_items`, `progress`) via the RPCs.

## Notes on versions

`api` targets **AI SDK v6** (`ai@^6`, `@ai-sdk/google@^3`) — structured output uses
`generateText` + `Output.object` (see `src/lib/ai.ts`). Confirm the current Gemini
model ids for your account; they're env-configurable (`CHAT_MODEL`, `EMBEDDING_MODEL`).
To route through Vercel AI Gateway (failover + cost tracking), swap the provider in
`src/lib/ai.ts` — call sites don't change.

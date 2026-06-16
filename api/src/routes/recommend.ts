import { Hono } from 'hono';
import type { AppBindings } from '../middleware/auth.js';
import { RecommendReq } from '../lib/schemas.js';

export const recommend = new Hono<AppBindings>();

// POST /v1/recommend — collaborative filtering + popularity + weather fit. The
// heavy lifting is the recommend_for_user RPC (runs next to the data); this just
// passes the verified user id and weather through. adminDb because the RPC is
// SECURITY DEFINER and reads cross-user stats, returning items only.
recommend.post('/', async (c) => {
  const { weather, limit } = RecommendReq.parse(await c.req.json().catch(() => ({})));
  const userId = c.get('userId');
  const db = c.get('db');

  // Over-fetch ranked candidates, then drop anything the user has already engaged
  // with. The RPC's own `seen` only excludes completed/saved/rated items, so an
  // item merely *opened* (e.g. read, never listened to the end) kept resurfacing
  // as the top pick. We also exclude in-progress items (those live in Continue).
  const want = Math.max(limit, 5);
  // The RPC ranks candidates; the two exclusion queries don't depend on it, so
  // run all three together rather than RPC-then-queries.
  const [rankedRes, evRes, progRes] = await Promise.all([
    c.get('adminDb').rpc('recommend_for_user', { p_user: userId, p_weather: weather ?? null, p_limit: Math.max(want * 6, 30) }),
    db.from('events').select('item_kind, item_id').in('type', ['page_open', 'page_complete', 'listen_complete']).not('item_id', 'is', null),
    db.from('progress').select('item_kind, item_id'),
  ]);
  if (rankedRes.error) throw rankedRes.error;
  const ranked = rankedRes.data ?? [];
  const ev = evRes.data;
  const prog = progRes.data;
  const engaged = new Set([...(ev ?? []), ...(prog ?? [])].map((r: any) => `${r.item_kind}:${r.item_id}`));

  const fresh = ranked.filter((it: any) => !engaged.has(`${it.kind}:${it.id}`));
  // Never return empty — if everything's been seen, fall back to the ranked list.
  const items = (fresh.length ? fresh : ranked).slice(0, want);
  return c.json({ items });
});

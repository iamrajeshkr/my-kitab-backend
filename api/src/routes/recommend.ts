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

  const { data, error } = await c.get('adminDb').rpc('recommend_for_user', {
    p_user: userId,
    p_weather: weather ?? null,
    p_limit: limit,
  });
  if (error) throw error;
  return c.json({ items: data ?? [] });
});

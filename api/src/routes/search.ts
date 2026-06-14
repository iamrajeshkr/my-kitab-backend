import { Hono } from 'hono';
import type { AppBindings } from '../middleware/auth.js';
import { SearchReq } from '../lib/schemas.js';
import { embedText, toVectorLiteral } from '../lib/ai.js';

export const search = new Hono<AppBindings>();

// POST /v1/search — feeling-based discovery. Embed the query, then let the
// HNSW index find the nearest items by meaning ("something for when I can't
// stop comparing myself"), not keywords.
search.post('/', async (c) => {
  const { q, lang, limit } = SearchReq.parse(await c.req.json());
  const embedding = await embedText(q);

  const { data, error } = await c.get('adminDb').rpc('search_items_by_feeling', {
    query_embedding: toVectorLiteral(embedding),
    p_lang: lang,
    match_count: limit,
  });
  if (error) throw error;
  return c.json({ items: data ?? [] });
});

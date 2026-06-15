import { Hono } from 'hono';
import type { AppBindings } from '../middleware/auth.js';
import { toVectorLiteral } from '../lib/ai.js';

export const similar = new Hono<AppBindings>();

// GET /v1/similar/:kind/:id?lang=en — "more like this", powering the player's
// up-next for single-track items. We average a sample of the item's chunk
// embeddings into a content centroid, then ask the feeling RPC for the nearest
// *items*. The item itself and anything the user has finished are excluded — so
// up-next/autoplay never re-serve completed content, though it stays searchable.
similar.get('/:kind/:id', async (c) => {
  const kind = c.req.param('kind');
  const id = c.req.param('id');
  const lang = c.req.query('lang') === 'hi' ? 'hi' : 'en';
  const admin = c.get('adminDb');

  // A sample of chunks is a fine centroid and keeps the payload small.
  const fetchChunks = (l: string) =>
    admin
      .from('content_chunks')
      .select('embedding')
      .eq('item_kind', kind)
      .eq('item_id', id)
      .eq('lang', l)
      .order('chunk_index', { ascending: true })
      .limit(12);

  let { data: chunks } = await fetchChunks(lang);
  if ((!chunks || !chunks.length) && lang !== 'en') ({ data: chunks } = await fetchChunks('en'));
  if (!chunks || !chunks.length) return c.json({ items: [] });

  const vecs = chunks
    .map((r: any) => (typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding))
    .filter((v: unknown): v is number[] => Array.isArray(v) && v.length > 0);
  if (!vecs.length) return c.json({ items: [] });

  const dim = vecs[0]!.length;
  const centroid = new Array<number>(dim).fill(0);
  for (const v of vecs) for (let i = 0; i < dim; i++) centroid[i] = (centroid[i] ?? 0) + (v[i] ?? 0);
  for (let i = 0; i < dim; i++) centroid[i] = (centroid[i] ?? 0) / vecs.length;

  const { data, error } = await admin.rpc('search_items_by_feeling', {
    query_embedding: toVectorLiteral(centroid),
    p_lang: lang,
    match_count: 16,
  });
  if (error) throw error;

  // Drop the seed item + anything finished (RLS-scoped to this user).
  const { data: done } = await c.get('db').from('progress').select('item_kind, item_id').not('completed_at', 'is', null);
  const doneSet = new Set((done ?? []).map((r: any) => `${r.item_kind}:${r.item_id}`));

  const items = (data ?? [])
    .filter((it: any) => !(it.kind === kind && it.id === id))
    .filter((it: any) => !doneSet.has(`${it.kind}:${it.id}`))
    .slice(0, 8);

  return c.json({ items });
});

import { Hono } from 'hono';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { AppBindings } from '../middleware/auth.js';

// Marginalia (your commonplace book) + Resonance (how many others underlined the
// same line). line_hash is set by a DB trigger on insert; for resonance we hash
// the quote the same way the trigger does: sha1(lower(trim(quote))).
const lineHash = (q: string) => createHash('sha1').update(q.trim().toLowerCase()).digest('hex');

const HighlightReq = z.object({
  kind: z.enum(['byte', 'journey', 'summary']),
  id: z.string().uuid(),
  lang: z.enum(['en', 'hi']).default('en'),
  quote: z.string().min(1).max(2000),
  note: z.string().max(2000).optional(),
});

export const highlights = new Hono<AppBindings>();

// POST /v1/highlights — underline a line (optionally with a margin note).
highlights.post('/', async (c) => {
  const b = HighlightReq.parse(await c.req.json());
  const { data, error } = await c.get('db')
    .from('highlights')
    .insert({ user_id: c.get('userId'), item_kind: b.kind, item_id: b.id, lang: b.lang, quote: b.quote, note: b.note ?? null })
    .select('id')
    .single();
  if (error) throw error;
  return c.json({ id: data!.id });
});

// GET /v1/highlights — the user's commonplace book (newest first, with titles).
highlights.get('/', async (c) => {
  const { data } = await c.get('db')
    .from('highlights')
    .select('id, item_kind, item_id, lang, quote, note, created_at')
    .order('created_at', { ascending: false })
    .limit(100);
  const list = data ?? [];
  if (!list.length) return c.json({ items: [] });
  const ids = [...new Set(list.map((h: any) => h.item_id))];
  const { data: meta } = await c.get('adminDb').from('content_items').select('kind, id, title').in('id', ids);
  const byKey = new Map((meta ?? []).map((m: any) => [`${m.kind}:${m.id}`, m.title]));
  return c.json({ items: list.map((h: any) => ({ ...h, title: byKey.get(`${h.item_kind}:${h.item_id}`) ?? '' })) });
});

// POST /v1/highlights/resonance — count + anonymised notes for a line.
highlights.post('/resonance', async (c) => {
  const { kind, id, quote } = z
    .object({ kind: z.enum(['byte', 'journey', 'summary']), id: z.string().uuid(), quote: z.string().min(1) })
    .parse(await c.req.json());
  const { data } = await c.get('db').rpc('get_resonance', { p_kind: kind, p_item: id, p_line_hash: lineHash(quote) });
  return c.json(data ?? { count: 0, samples: [] });
});

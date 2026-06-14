import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../middleware/auth.js';

// Cross-device "continue where you left off". Position is a content-type-aware
// blob (the client decides its shape):
//   byte/summary -> { audioSec, durationSec, completed }
//   journey      -> { section, subsection, chapterSeq, totalChapters, audioSec, completed }
// Stored in the progress table (RLS-scoped to the user), so it syncs everywhere.

const SaveReq = z.object({
  kind: z.enum(['byte', 'journey', 'summary']),
  id: z.string().uuid(),
  position: z.record(z.string(), z.unknown()),
});

export const progress = new Hono<AppBindings>();

// POST /v1/progress — upsert the user's place in an item.
progress.post('/', async (c) => {
  const { kind, id, position } = SaveReq.parse(await c.req.json());
  const db = c.get('db');
  await db.rpc('upsert_progress', { p_kind: kind, p_item: id, p_position: position });
  await db.rpc('log_event', {
    p_type: (position as any).completed ? 'listen_complete' : 'listen_progress',
    p_kind: kind,
    p_item: id,
    p_payload: position,
  });
  return c.json({ ok: true });
});

// GET /v1/progress/:kind/:id — the saved position for one item (resume on open).
progress.get('/:kind/:id', async (c) => {
  const { data } = await c.get('db')
    .from('progress')
    .select('position, updated_at')
    .eq('item_kind', c.req.param('kind'))
    .eq('item_id', c.req.param('id'))
    .maybeSingle();
  return c.json({ position: data?.position ?? null, updated_at: data?.updated_at ?? null });
});

// GET /v1/progress — recent in-progress items, enriched with title/cover for the
// home "Continue" rail.
progress.get('/', async (c) => {
  const { data: rows } = await c.get('db')
    .from('progress')
    .select('item_kind, item_id, position, updated_at')
    .order('updated_at', { ascending: false })
    .limit(12);
  const list = rows ?? [];
  if (!list.length) return c.json({ items: [] });

  const ids = [...new Set(list.map((r) => r.item_id as string))];
  const { data: meta } = await c.get('adminDb').from('content_items').select('kind, id, title, author, cover').in('id', ids);
  const byKey = new Map((meta ?? []).map((m: any) => [`${m.kind}:${m.id}`, m]));

  const items = list
    .map((r: any) => {
      const m = byKey.get(`${r.item_kind}:${r.item_id}`);
      if (!m) return null; // content removed
      return { kind: r.item_kind, id: r.item_id, title: m.title, author: m.author, cover: m.cover, position: r.position, updated_at: r.updated_at };
    })
    .filter(Boolean);

  return c.json({ items });
});

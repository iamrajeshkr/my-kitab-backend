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
  const completed = (position as any).completed === true;

  await db.rpc('upsert_progress', { p_kind: kind, p_item: id, p_position: position });
  await db.rpc('log_event', {
    p_type: completed ? 'listen_complete' : 'listen_progress',
    p_kind: kind,
    p_item: id,
    p_payload: position,
  });

  // Sticky completion marker: set once, never cleared on replay. It's the durable
  // "finished" record that feeds the Garden. Continue stays position-based (an item
  // replayed to <100% resurfaces there); recommend/up-next exclusion rides the
  // listen_complete event above — so a finished item is never re-suggested, yet
  // stays fully searchable and replayable.
  if (completed) {
    await db
      .from('progress')
      .update({ completed_at: new Date().toISOString() })
      .eq('item_kind', kind)
      .eq('item_id', id)
      .is('completed_at', null);
  }
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
    .limit(40);
  // Continue = items whose *current* place is < 100%. An item finished long ago
  // (completed_at set) but replayed partway through still belongs here, so we key
  // off the live position flag, not the sticky marker.
  const list = (rows ?? []).filter((r: any) => r.position?.completed !== true).slice(0, 12);
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

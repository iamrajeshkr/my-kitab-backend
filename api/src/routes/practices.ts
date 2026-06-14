import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../middleware/auth.js';

export const practices = new Hono<AppBindings>();

const CreateReq = z.object({
  text: z.string().min(1).max(500),
  source_kind: z.enum(['byte', 'journey', 'summary']).optional(),
  source_id: z.string().uuid().optional(),
  keep: z.boolean().default(true), // accepting a "carry" = committing to it
});

// POST /v1/practices — create a practice (the Practice Loop "carry"). Defaults
// to kept (kept_count 1) since the user is choosing to take it into tomorrow.
practices.post('/', async (c) => {
  const b = CreateReq.parse(await c.req.json());
  const db = c.get('db');
  const { data, error } = await db
    .from('practices')
    .insert({
      user_id: c.get('userId'),
      text: b.text,
      source_kind: b.source_kind ?? null,
      source_id: b.source_id ?? null,
      status: b.keep ? 'kept' : 'active',
      kept_count: b.keep ? 1 : 0,
      last_kept_at: b.keep ? new Date().toISOString() : null,
    })
    .select('id')
    .single();
  if (error) throw error;
  await db.rpc('log_event', { p_type: 'practice_set', p_payload: { practice_id: data!.id } });
  if (b.keep) await db.rpc('log_event', { p_type: 'practice_kept', p_payload: { practice_id: data!.id } });
  return c.json({ id: data!.id });
});

// POST /v1/practices/:id/keep — mark a kept day for an existing practice (garden).
practices.post('/:id/keep', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
  const { error } = await c.get('db').rpc('keep_practice', { p_practice: id });
  if (error) throw error;
  return c.json({ ok: true });
});

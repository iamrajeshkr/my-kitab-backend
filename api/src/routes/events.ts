import { Hono } from 'hono';
import type { AppBindings } from '../middleware/auth.js';
import { EventsReq } from '../lib/schemas.js';

export const events = new Hono<AppBindings>();

// POST /v1/events — batched event ingest. The client buffers interactions and
// flushes them in one request. Inserted via the RLS-scoped client so a user can
// only ever write their own events (user_id is forced, never client-supplied).
events.post('/', async (c) => {
  const { events: batch } = EventsReq.parse(await c.req.json());
  const userId = c.get('userId');

  const rows = batch.map((e) => ({
    user_id: userId,
    type: e.type,
    item_kind: e.kind ?? null,
    item_id: e.id ?? null,
    payload: e.payload,
  }));

  const { error, count } = await c.get('db')
    .from('events')
    .insert(rows, { count: 'exact' });
  if (error) throw error;
  return c.json({ accepted: count ?? rows.length });
});

import { Hono } from 'hono';
import type { AppBindings } from '../middleware/auth.js';

export const garden = new Hono<AppBindings>();

// GET /v1/garden — felt-progress summary: practices kept, pages read, days, and
// the recent "leaves". One RPC, computed next to the data.
garden.get('/', async (c) => {
  const { data, error } = await c.get('db').rpc('garden_summary', { p_user: c.get('userId') });
  if (error) throw error;
  return c.json(data);
});

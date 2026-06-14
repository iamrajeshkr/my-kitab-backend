import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../middleware/auth.js';

// Becoming arcs — multi-step transformation journeys. Tables (arcs/arc_steps/
// user_arcs) + enroll_arc/advance_arc RPCs already exist and are seeded.

export const arcs = new Hono<AppBindings>();

// GET /v1/arcs — all arcs + this user's enrollment/progress.
arcs.get('/', async (c) => {
  const [{ data: list }, { data: mine }] = await Promise.all([
    c.get('adminDb').from('arcs').select('id, slug, title, subtitle, total_steps, goal_weather').order('id'),
    c.get('db').from('user_arcs').select('arc_id, current_step, completed_at'),
  ]);
  const byArc = new Map((mine ?? []).map((u: any) => [u.arc_id, u]));
  return c.json({ arcs: (list ?? []).map((a: any) => ({ ...a, enrollment: byArc.get(a.id) ?? null })) });
});

// GET /v1/arcs/:slug — arc + steps (with content meta) + this user's progress.
arcs.get('/:slug', async (c) => {
  const admin = c.get('adminDb');
  const { data: arc } = await admin.from('arcs').select('*').eq('slug', c.req.param('slug')).maybeSingle();
  if (!arc) return c.json({ error: 'not found' }, 404);
  const [{ data: steps }, { data: mine }] = await Promise.all([
    admin.from('arc_steps').select('step_index, title, item_kind, item_id, prompt').eq('arc_id', arc.id).order('step_index'),
    c.get('db').from('user_arcs').select('current_step, completed_at').eq('arc_id', arc.id).maybeSingle(),
  ]);
  const ids = [...new Set((steps ?? []).map((s: any) => s.item_id).filter(Boolean))];
  const { data: meta } = ids.length
    ? await admin.from('content_items').select('kind, id, title, cover').in('id', ids)
    : { data: [] };
  const byKey = new Map((meta ?? []).map((m: any) => [`${m.kind}:${m.id}`, m]));
  const stepsOut = (steps ?? []).map((s: any) => ({ ...s, item: s.item_id ? byKey.get(`${s.item_kind}:${s.item_id}`) ?? null : null }));
  return c.json({ arc, steps: stepsOut, enrollment: mine ?? null });
});

// POST /v1/arcs/:slug/enroll
arcs.post('/:slug/enroll', async (c) => {
  const { data, error } = await c.get('db').rpc('enroll_arc', { p_slug: c.req.param('slug') });
  if (error) throw error;
  return c.json({ arcId: data });
});

// POST /v1/arcs/advance  { arc_id }
arcs.post('/advance', async (c) => {
  const { arc_id } = z.object({ arc_id: z.number() }).parse(await c.req.json());
  const { data, error } = await c.get('db').rpc('advance_arc', { p_arc: arc_id });
  if (error) throw error;
  return c.json({ step: data });
});

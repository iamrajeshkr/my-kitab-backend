import { Hono } from 'hono';
import type { AppBindings } from '../middleware/auth.js';

export const garden = new Hono<AppBindings>();

// Consecutive recent days (UTC) with any activity, ending today or yesterday —
// a gentle streak that doesn't break the instant you miss a single day.
function computeStreak(timestamps: string[]): number {
  const days = new Set(timestamps.map((t) => t.slice(0, 10))); // YYYY-MM-DD
  if (!days.size) return 0;
  const DAY = 86_400_000;
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
  if (!days.has(today) && !days.has(yesterday)) return 0;
  let streak = 0;
  let cursor = days.has(today) ? Date.now() : Date.now() - DAY;
  for (;;) {
    const d = new Date(cursor).toISOString().slice(0, 10);
    if (!days.has(d)) break;
    streak += 1;
    cursor -= DAY;
  }
  return streak;
}

// GET /v1/garden — felt-progress summary for the You screen. The garden_summary
// RPC gives stats + practice "leaves"; we add the finished-reads shelf (Living
// Library spines / Inner-Sky stars), an in-progress count, and a quiet streak.
garden.get('/', async (c) => {
  const db = c.get('db');
  const userId = c.get('userId');

  const { data: summary, error } = await db.rpc('garden_summary', { p_user: userId });
  if (error) throw error;

  // Finished reads (sticky completed_at), newest first, joined to display fields.
  const { data: done } = await db
    .from('progress')
    .select('item_kind, item_id, completed_at')
    .not('completed_at', 'is', null)
    .order('completed_at', { ascending: false })
    .limit(60);
  const dlist = done ?? [];

  let finished: any[] = [];
  if (dlist.length) {
    const ids = [...new Set(dlist.map((d: any) => d.item_id as string))];
    const { data: meta } = await c
      .get('adminDb')
      .from('content_items')
      .select('kind, id, title, author, cover, category')
      .in('id', ids);
    const byKey = new Map((meta ?? []).map((m: any) => [`${m.kind}:${m.id}`, m]));
    finished = dlist
      .map((d: any) => {
        const m = byKey.get(`${d.item_kind}:${d.item_id}`);
        return m
          ? { kind: d.item_kind, id: d.item_id, title: m.title, author: m.author, cover: m.cover, category: m.category, completed_at: d.completed_at }
          : null;
      })
      .filter(Boolean);
  }

  // Started but unfinished — powers "N in progress" on the shelf.
  const { count: inProgress } = await db
    .from('progress')
    .select('item_kind', { count: 'exact', head: true })
    .is('completed_at', null);

  // Quiet streak from recent activity.
  const since = new Date(Date.now() - 32 * 86_400_000).toISOString();
  const { data: ev } = await db
    .from('events')
    .select('created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(400);
  const streak = computeStreak((ev ?? []).map((e: any) => e.created_at as string));

  return c.json({ ...(summary as object), finished, in_progress: inProgress ?? 0, streak });
});

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../middleware/auth.js';

export const playlists = new Hono<AppBindings>();

const ItemReq = z.object({ kind: z.enum(['byte', 'journey', 'summary']), id: z.string().uuid() });
const NameReq = z.object({ name: z.string().trim().min(1).max(60) });

// Join (kind,id) rows to their display fields via the service-role client.
async function enrich(adminDb: AppBindings['Variables']['adminDb'], rows: { item_kind: string; item_id: string }[]) {
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((r) => r.item_id))];
  const { data: meta } = await adminDb.from('content_items').select('kind, id, title, author, cover, category').in('id', ids);
  const byKey = new Map((meta ?? []).map((m: any) => [`${m.kind}:${m.id}`, m]));
  return rows
    .map((r) => {
      const m = byKey.get(`${r.item_kind}:${r.item_id}`);
      return m ? { kind: r.item_kind, id: r.item_id, title: m.title, author: m.author, cover: m.cover, category: m.category } : null;
    })
    .filter(Boolean);
}

// GET /v1/playlists?item=kind:id — list collections with counts. With ?item, each
// also gets `has` (does this collection already contain that item) — powers the
// bookmark picker.
playlists.get('/', async (c) => {
  const db = c.get('db');
  const item = c.req.query('item'); // "kind:id"
  const { data: pls } = await db.from('playlists').select('id, name, created_at').order('created_at', { ascending: true });
  const ids = (pls ?? []).map((p: any) => p.id);

  const counts = new Map<number, number>();
  const has = new Set<number>();
  if (ids.length) {
    const { data: its } = await db.from('playlist_items').select('playlist_id, item_kind, item_id').in('playlist_id', ids);
    for (const it of its ?? []) counts.set(it.playlist_id, (counts.get(it.playlist_id) ?? 0) + 1);
    if (item) {
      const [k, i] = item.split(':');
      for (const it of its ?? []) if (it.item_kind === k && it.item_id === i) has.add(it.playlist_id);
    }
  }
  return c.json({
    playlists: (pls ?? []).map((p: any) => ({ id: p.id, name: p.name, count: counts.get(p.id) ?? 0, ...(item ? { has: has.has(p.id) } : {}) })),
  });
});

// GET /v1/playlists/saved — the Saved-tab payload: collections (+counts), the
// commonplace line count, and a recently-saved feed (deduped, enriched).
playlists.get('/saved', async (c) => {
  const db = c.get('db');
  const [{ data: pls }, { count: highlights }] = await Promise.all([
    db.from('playlists').select('id, name, created_at').order('created_at', { ascending: true }),
    db.from('highlights').select('id', { count: 'exact', head: true }),
  ]);
  const ids = (pls ?? []).map((p: any) => p.id);

  let recentRows: any[] = [];
  const counts = new Map<number, number>();
  const coverRows = new Map<number, any[]>(); // playlist_id -> up to 4 items for a collage
  if (ids.length) {
    const { data: its } = await db
      .from('playlist_items')
      .select('playlist_id, item_kind, item_id, created_at')
      .in('playlist_id', ids)
      .order('created_at', { ascending: false })
      .limit(200);
    const seen = new Set<string>();
    for (const it of its ?? []) {
      counts.set(it.playlist_id, (counts.get(it.playlist_id) ?? 0) + 1);
      const arr = coverRows.get(it.playlist_id) ?? [];
      if (arr.length < 4) { arr.push(it); coverRows.set(it.playlist_id, arr); }
      const key = `${it.item_kind}:${it.item_id}`;
      if (!seen.has(key)) { seen.add(key); recentRows.push(it); }
    }
    recentRows = recentRows.slice(0, 16);
  }

  // one enrich pass over everything we need to display
  const allRows = [...recentRows, ...[...coverRows.values()].flat()];
  const enriched = await enrich(c.get('adminDb'), allRows);
  const byKey = new Map(enriched.map((m: any) => [`${m.kind}:${m.id}`, m]));
  const coversFor = (pid: number) =>
    (coverRows.get(pid) ?? []).map((r: any) => byKey.get(`${r.item_kind}:${r.item_id}`)).filter(Boolean);

  return c.json({
    collections: (pls ?? []).map((p: any) => ({ id: p.id, name: p.name, count: counts.get(p.id) ?? 0, covers: coversFor(p.id) })),
    highlights_count: highlights ?? 0,
    recent: recentRows.map((r: any) => byKey.get(`${r.item_kind}:${r.item_id}`)).filter(Boolean),
  });
});

// DELETE /v1/playlists/saved/:kind/:itemId — remove an item from ALL the user's
// collections at once (the "delete from saved everywhere" gesture). RLS keeps it
// scoped to playlists the user owns.
playlists.delete('/saved/:kind/:itemId', async (c) => {
  const { error } = await c
    .get('db')
    .from('playlist_items')
    .delete()
    .eq('item_kind', c.req.param('kind'))
    .eq('item_id', c.req.param('itemId'));
  if (error) throw error;
  return c.json({ ok: true });
});

// POST /v1/playlists { name } — create a collection.
playlists.post('/', async (c) => {
  const { name } = NameReq.parse(await c.req.json());
  const { data, error } = await c.get('db').from('playlists').insert({ user_id: c.get('userId'), name }).select('id, name').single();
  if (error) throw error;
  return c.json({ id: data!.id, name: data!.name });
});

// GET /v1/playlists/:id — open a collection (items, enriched).
playlists.get('/:id', async (c) => {
  const db = c.get('db');
  const id = Number(c.req.param('id'));
  const { data: pl } = await db.from('playlists').select('id, name').eq('id', id).maybeSingle();
  if (!pl) return c.json({ error: 'not found' }, 404);
  const { data: its } = await db
    .from('playlist_items')
    .select('item_kind, item_id, created_at')
    .eq('playlist_id', id)
    .order('created_at', { ascending: false });
  return c.json({ id: pl.id, name: pl.name, items: await enrich(c.get('adminDb'), its ?? []) });
});

// DELETE /v1/playlists/:id — remove a collection (items cascade).
playlists.delete('/:id', async (c) => {
  const { error } = await c.get('db').from('playlists').delete().eq('id', Number(c.req.param('id')));
  if (error) throw error;
  return c.json({ ok: true });
});

// POST /v1/playlists/:id/items { kind, id } — add an item.
playlists.post('/:id/items', async (c) => {
  const { kind, id } = ItemReq.parse(await c.req.json());
  const { error } = await c.get('db').from('playlist_items').upsert(
    { playlist_id: Number(c.req.param('id')), item_kind: kind, item_id: id },
    { onConflict: 'playlist_id,item_kind,item_id' }
  );
  if (error) throw error;
  return c.json({ ok: true });
});

// DELETE /v1/playlists/:id/items/:kind/:itemId — remove an item.
playlists.delete('/:id/items/:kind/:itemId', async (c) => {
  const { error } = await c
    .get('db')
    .from('playlist_items')
    .delete()
    .eq('playlist_id', Number(c.req.param('id')))
    .eq('item_kind', c.req.param('kind'))
    .eq('item_id', c.req.param('itemId'));
  if (error) throw error;
  return c.json({ ok: true });
});

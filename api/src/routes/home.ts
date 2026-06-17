import { Hono } from 'hono';
import type { AppBindings } from '../middleware/auth.js';
import { toVectorLiteral } from '../lib/ai.js';

export const home = new Hono<AppBindings>();

type Ref = { kind: string; id: string; title: string; author: string | null; cover: string | null };

// GET /v1/home?weather=&lang=&hour= — the personalized shelf in one round-trip:
// a weather-fit hero plus content rails (each a reason a person would buy).
// Continue + Wander stay as their own client widgets.
home.get('/', async (c) => {
  const db = c.get('db');
  const admin = c.get('adminDb');
  const userId = c.get('userId');
  const weather = c.req.query('weather') || null;
  const lang = c.req.query('lang') === 'hi' ? 'hi' : 'en';

  // --- what the user has engaged with (for affinity + exclusion) ---
  const [{ data: ev }, { data: prog }] = await Promise.all([
    db.from('events').select('item_kind, item_id, type').in('type', ['page_open', 'page_complete', 'listen_complete']).not('item_id', 'is', null).limit(500),
    db.from('progress').select('item_kind, item_id, completed_at, updated_at').order('updated_at', { ascending: false }).limit(120),
  ]);
  const engaged = new Set<string>();
  for (const e of ev ?? []) engaged.add(`${e.item_kind}:${e.item_id}`);
  for (const p of prog ?? []) engaged.add(`${p.item_kind}:${p.item_id}`);
  const finishedRows = (prog ?? []).filter((p: any) => p.completed_at != null).sort((a: any, b: any) => (a.completed_at < b.completed_at ? 1 : -1));
  const latestFinished = finishedRows[0];

  // affinity: top categories + author from engaged items' metadata
  const engagedIds = [...new Set([...(ev ?? []), ...(prog ?? [])].map((r: any) => r.item_id))];
  const meta = new Map<string, any>();
  if (engagedIds.length) {
    const { data } = await admin.from('content_items').select('kind, id, title, author, category').in('id', engagedIds);
    for (const m of data ?? []) meta.set(`${m.kind}:${m.id}`, m);
  }
  const catCount = new Map<string, number>();
  const authorCount = new Map<string, number>();
  for (const k of engaged) {
    const m = meta.get(k);
    if (!m) continue;
    if (m.category) catCount.set(m.category, (catCount.get(m.category) ?? 0) + 1);
    if (m.author) authorCount.set(m.author, (authorCount.get(m.author) ?? 0) + 1);
  }
  const topCats = [...catCount.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const topAuthor = [...authorCount.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a)[0];

  // --- pull candidate pools in parallel ---
  const sel = 'kind, id, title, author, cover, category';
  const [recRes, themeRes, authorRes, shortRes, freshRes] = await Promise.all([
    admin.rpc('recommend_for_user', { p_user: userId, p_weather: weather, p_limit: 30 }),
    topCats[0] ? admin.from('content_items').select(sel).eq('category', topCats[0]).limit(40) : Promise.resolve({ data: [] as any[] }),
    topAuthor ? admin.from('content_items').select(sel).eq('author', topAuthor).limit(40) : Promise.resolve({ data: [] as any[] }),
    admin.from('content_items').select(sel).eq('kind', 'byte').limit(60),
    admin.from('content_items').select(sel).order('created_at', { ascending: false }).limit(60),
  ]);
  const recItems = (recRes.data ?? []) as any[];

  // hero = the top weather-fit pick
  const top = recItems[0];
  const hero = top ? { kind: top.kind, id: top.id, title: top.title, author: top.author, cover: top.cover, reason: top.reason } : null;

  // cross-rail dedup: an item shows in at most one rail, and never if engaged.
  const used = new Set<string>(engaged);
  if (hero) used.add(`${hero.kind}:${hero.id}`);
  const take = (rows: any[], n = 10): Ref[] => {
    const out: Ref[] = [];
    for (const r of rows ?? []) {
      const key = `${r.kind}:${r.id}`;
      if (!r?.id || used.has(key)) continue;
      used.add(key);
      out.push({ kind: r.kind, id: r.id, title: r.title, author: r.author, cover: r.cover });
      if (out.length >= n) break;
    }
    return out;
  };

  // "Because you finished X" — nearest items to the last completed read.
  let finishedRail: Ref[] = [];
  let finishedTitle = '';
  if (latestFinished) {
    finishedTitle = meta.get(`${latestFinished.item_kind}:${latestFinished.item_id}`)?.title ?? '';
    const { data: chunks } = await admin
      .from('content_chunks')
      .select('embedding')
      .eq('item_kind', latestFinished.item_kind)
      .eq('item_id', latestFinished.item_id)
      .eq('lang', lang)
      .limit(12);
    const vecs = (chunks ?? [])
      .map((r: any) => (typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding))
      .filter((v: unknown): v is number[] => Array.isArray(v) && v.length > 0);
    if (vecs.length) {
      const dim = vecs[0]!.length;
      const cen = new Array<number>(dim).fill(0);
      for (const v of vecs) for (let i = 0; i < dim; i++) cen[i] = (cen[i] ?? 0) + (v[i] ?? 0);
      for (let i = 0; i < dim; i++) cen[i] = (cen[i] ?? 0) / vecs.length;
      const { data: sim } = await admin.rpc('search_items_by_feeling', { query_embedding: toVectorLiteral(cen), p_lang: lang, match_count: 16 });
      finishedRail = take(sim ?? [], 10);
    }
  }

  // --- assemble rails (order = priority; each filtered to non-empty) ---
  const rails: { key: string; title: string; subtitle?: string; items: Ref[] }[] = [];
  if (finishedRail.length) rails.push({ key: 'finished', title: `Because you finished “${finishedTitle}”`, items: finishedRail });
  if (topCats[0]) { const it = take(themeRes.data ?? [], 10); if (it.length) rails.push({ key: 'theme', title: `More on ${topCats[0]}`, items: it }); }
  if (topAuthor) { const it = take(authorRes.data ?? [], 10); if (it.length) rails.push({ key: 'author', title: `More from ${topAuthor}`, items: it }); }
  { const it = take(recItems, 10); if (it.length) rails.push({ key: 'cf', title: 'Readers like you also returned to', items: it }); }
  { const it = take(shortRes.data ?? [], 10); if (it.length) rails.push({ key: 'short', title: 'Short enough for tonight', items: it }); }
  { const it = take(freshRes.data ?? [], 10); if (it.length) rails.push({ key: 'new', title: topCats[0] ? 'New in your themes' : 'New on Bingent', items: it }); }
  { const outside = (freshRes.data ?? []).filter((r: any) => r.category && !topCats.includes(r.category)); const it = take(outside, 8); if (it.length) rails.push({ key: 'outside', title: 'Step outside', subtitle: 'A little beyond your usual', items: it }); }

  return c.json({ hero, rails });
});

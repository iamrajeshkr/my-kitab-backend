import { Hono } from 'hono';
import type { AppBindings } from '../middleware/auth.js';
import { embedText, toVectorLiteral } from '../lib/ai.js';

// Curated "threads" — themed collections that invite browsing. Each theme is a
// semantic query over the catalog (reuses the embeddings + search RPC), so the
// items stay fresh as the library grows. Themes are static → cache per lang.

// note + colors turn each thread into an editorial "reading room" (Discover).
const THEMES = [
  { slug: 'comparison', title: 'When comparison creeps in', q: 'comparing myself to others, envy, feeling behind, not enough',
    note: "For the quiet ache of measuring your life against everyone else's.", bg: '#2A3B22', accent: '#E2A24A' },
  { slug: 'sleep', title: 'Learning to rest', q: 'restless at night, calm the racing mind before sleep, deep rest',
    note: "Ways back to sleep when the mind won't close the door.", bg: '#43395E', accent: '#C4A6E8' },
  { slug: 'focus', title: 'Find your focus', q: 'distracted, scattered attention, deep focus, single-tasking, presence',
    note: 'Gather a scattered mind back to one quiet point.', bg: '#1F4A45', accent: '#E2A24A' },
  { slug: 'anger', title: 'When anger rises', q: 'anger, frustration, irritation, responding from a calm centre',
    note: 'Meet the heat with a steadier, kinder centre.', bg: '#A8452A', accent: '#F0CE86' },
  { slug: 'meaning', title: 'A bigger why', q: 'purpose, meaning, what matters, values, becoming who you want to be',
    note: 'For the search beneath the day-to-day — what it all is for.', bg: '#13233A', accent: '#E2A24A' },
];

type Thread = { slug: string; title: string; note: string; bg: string; accent: string; items: { kind: string; id: string }[] };

const cache = new Map<string, Thread[]>();

export const threads = new Hono<AppBindings>();

threads.get('/', async (c) => {
  const lang = c.req.query('lang') === 'hi' ? 'hi' : 'en';

  // The themed search (embed + vector) is identical for everyone, so cache it
  // per-lang. We over-fetch (8) to leave headroom for the per-user finished
  // filter below, which can't be cached because it's user-specific.
  let raw = cache.get(lang) as Thread[] | undefined;
  if (!raw) {
    const admin = c.get('adminDb');
    raw = await Promise.all(
      THEMES.map(async (t) => {
        const emb = await embedText(t.q, 'RETRIEVAL_QUERY');
        const { data } = await admin.rpc('search_items_by_feeling', {
          query_embedding: toVectorLiteral(emb),
          p_lang: lang,
          match_count: 8,
        });
        return { slug: t.slug, title: t.title, note: t.note, bg: t.bg, accent: t.accent, items: (data ?? []) as Thread['items'] };
      })
    );
    cache.set(lang, raw);
  }

  // Drop anything this user has finished (same rule as up-next), then trim to 4.
  const { data: done } = await c.get('db').from('progress').select('item_kind, item_id').not('completed_at', 'is', null);
  const doneSet = new Set((done ?? []).map((r: any) => `${r.item_kind}:${r.item_id}`));
  const threadsOut = raw.map((t) => ({
    slug: t.slug,
    title: t.title,
    note: t.note,
    bg: t.bg,
    accent: t.accent,
    items: t.items.filter((it) => !doneSet.has(`${it.kind}:${it.id}`)).slice(0, 4),
  }));

  return c.json({ threads: threadsOut });
});

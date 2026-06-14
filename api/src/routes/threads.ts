import { Hono } from 'hono';
import type { AppBindings } from '../middleware/auth.js';
import { embedText, toVectorLiteral } from '../lib/ai.js';

// Curated "threads" — themed collections that invite browsing. Each theme is a
// semantic query over the catalog (reuses the embeddings + search RPC), so the
// items stay fresh as the library grows. Themes are static → cache per lang.

const THEMES = [
  { slug: 'comparison', title: 'When comparison creeps in', q: 'comparing myself to others, envy, feeling behind, not enough' },
  { slug: 'sleep', title: 'Wind down to sleep', q: 'restless at night, calm the racing mind before sleep, deep rest' },
  { slug: 'focus', title: 'Find your focus', q: 'distracted, scattered attention, deep focus, single-tasking, presence' },
  { slug: 'anger', title: 'When anger rises', q: 'anger, frustration, irritation, responding from a calm centre' },
  { slug: 'meaning', title: 'A bigger why', q: 'purpose, meaning, what matters, values, becoming who you want to be' },
];

const cache = new Map<string, unknown>();

export const threads = new Hono<AppBindings>();

threads.get('/', async (c) => {
  const lang = c.req.query('lang') === 'hi' ? 'hi' : 'en';
  if (cache.has(lang)) return c.json(cache.get(lang));

  const admin = c.get('adminDb');
  const out = await Promise.all(
    THEMES.map(async (t) => {
      const emb = await embedText(t.q, 'RETRIEVAL_QUERY');
      const { data } = await admin.rpc('search_items_by_feeling', {
        query_embedding: toVectorLiteral(emb),
        p_lang: lang,
        match_count: 4,
      });
      return { slug: t.slug, title: t.title, items: data ?? [] };
    })
  );
  const payload = { threads: out };
  cache.set(lang, payload);
  return c.json(payload);
});

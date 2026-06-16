import { Hono } from 'hono';
import type { AppBindings } from '../middleware/auth.js';
import { CompanionReq, CompanionReply } from '../lib/schemas.js';
import { embedText, toVectorLiteral, generateStructured } from '../lib/ai.js';

export const companion = new Hono<AppBindings>();

// POST /v1/companion — "Ask Bingent". The memory-aware librarian. Semantic search
// surfaces candidate items, the user's memories personalise the tone, and the
// model writes a warm reply + picks 1–3 items strictly from the candidates
// (grounded — it can't recommend something that isn't in the library).
companion.post('/', async (c) => {
  const { query, lang, history } = CompanionReq.parse(await c.req.json());
  const db = c.get('db');

  // Memories don't depend on the embedding, so fetch them while we embed.
  const memP = db.from('memories').select('text').eq('is_visible', true).order('salience', { ascending: false }).limit(5);
  const embedding = await embedText(query, 'RETRIEVAL_QUERY');
  const [{ data: items }, { data: mems }] = await Promise.all([
    c.get('adminDb').rpc('search_items_by_feeling', {
      query_embedding: toVectorLiteral(embedding),
      p_lang: lang,
      match_count: 12,
    }),
    memP,
  ]);

  const candidates = (items ?? []) as Array<{ kind: string; id: string; title: string; author: string | null; cover: string | null }>;
  const memory = (mems ?? []).map((m) => m.text as string);

  const system =
    'You are "Ask Bingent", a warm, wise librarian inside a bilingual mindfulness app. The reader ' +
    'tells you how they feel or what they want to become. Reply with 2–3 gentle, concrete ' +
    'sentences, then recommend 1–3 items chosen ONLY from the CANDIDATES (by their ids). Prefer a ' +
    'journey for sustained change, a byte for today, a summary for depth. ' +
    (lang === 'hi' ? 'Reply in Hindi (Devanagari).' : 'Reply in plain English.');

  const prompt =
    (history.length ? `CONVERSATION SO FAR:\n${history.map((h) => `${h.role}: ${h.text}`).join('\n')}\n\n` : '') +
    (memory.length ? `WHAT YOU REMEMBER ABOUT THEM:\n- ${memory.join('\n- ')}\n\n` : '') +
    `CANDIDATES:\n${candidates.map((i) => `id:${i.id} | ${i.kind} | "${i.title}" by ${i.author ?? ''}`).join('\n')}\n\n` +
    `READER: ${query}`;

  const out = await generateStructured(CompanionReply, { system, prompt, temperature: 0.7 });

  const valid = new Set(candidates.map((i) => i.id));
  const chosen = (out.item_ids ?? []).filter((id) => valid.has(id)).slice(0, 3);
  const picked = candidates.filter((i) => chosen.includes(i.id));

  return c.json({ reply: out.reply, items: picked });
});

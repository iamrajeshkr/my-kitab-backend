import { Hono } from 'hono';
import type { AppBindings } from '../middleware/auth.js';
import { ComposeReq, ComposedPage } from '../lib/schemas.js';
import { retrieve, groundingBlock, validateCitations } from '../lib/rag.js';
import { generateStructured } from '../lib/ai.js';
import { timed } from '../lib/logger.js';

const WEATHER_PHRASE: Record<string, string> = {
  heavy: 'feeling heavy and low tonight',
  restless: 'restless and unable to settle',
  cloudy: 'cloudy, foggy, unclear',
  clear: 'calm and clear',
  bright: 'bright and open',
};

export const compose = new Hono<AppBindings>();

// POST /v1/compose-page — write tonight's page from the wisdom corpus + the
// user's state, and return the exact passages it was grounded in.
compose.post('/', async (c) => {
  const { weather, intent, lang } = ComposeReq.parse(await c.req.json());
  const db = c.get('db');
  const userId = c.get('userId');

  const [memoriesRes, chunks] = await Promise.all([
    db.from('memories').select('text').eq('is_visible', true).order('salience', { ascending: false }).limit(5),
    timed('compose.retrieve', () =>
      retrieve(`${WEATHER_PHRASE[weather]}. ${intent ?? ''}`.trim(), lang, { k: 8 })
    ),
  ]);
  const memories = (memoriesRes.data ?? []).map((m) => m.text as string);

  const system =
    'You are Bingent, a warm, literary companion in a bilingual mindfulness app. Write ONE short ' +
    'original page (1–3 short paragraphs) for the reader\'s state. Ground every idea in the ' +
    'PASSAGES below — do not invent teachings. Put the passage ids you drew from in the ' +
    'citations field ONLY; never write [#n] markers or ids in the prose itself. ' +
    (lang === 'hi' ? 'Write in natural Hindi (Devanagari).' : 'Write in calm, plain English.');

  const prompt =
    `READER STATE: ${WEATHER_PHRASE[weather]}.\n` +
    (intent ? `THEIR INTENT: "${intent}".\n` : '') +
    (memories.length ? `WHAT YOU REMEMBER ABOUT THEM:\n- ${memories.join('\n- ')}\n` : '') +
    `\nPASSAGES (cite by id):\n${groundingBlock(chunks)}`;

  const page = await timed('compose.generate', () =>
    generateStructured(ComposedPage, { system, prompt, temperature: 0.7 })
  );
  const citationIds = validateCitations(page.citations ?? [], chunks);

  await db.rpc('log_event', { p_type: 'compose_page', p_payload: { weather, lang } });

  return c.json({
    title: page.title,
    paragraphs: page.paragraphs,
    sources: chunks
      .filter((ch) => citationIds.includes(ch.id))
      .map((ch) => ({ kind: ch.item_kind, id: ch.item_id, heading: ch.heading })),
    user: userId,
  });
});

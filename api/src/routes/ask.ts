import { Hono } from 'hono';
import type { AppBindings } from '../middleware/auth.js';
import { AskReq, LineAnswer } from '../lib/schemas.js';
import { retrieveFromItem, groundingBlock } from '../lib/rag.js';
import { generateStructured } from '../lib/ai.js';

export const ask = new Hono<AppBindings>();

// POST /v1/ask-line — answer a question about a specific underlined line, in the
// author's voice, grounded ONLY in that item's passages. If it can't be grounded
// the model says so (grounded:false) and the client shows a soft fallback.
ask.post('/', async (c) => {
  const { kind, id, lang, quote, question } = AskReq.parse(await c.req.json());
  const db = c.get('db');

  const chunks = await retrieveFromItem(kind, id, lang);

  const system =
    'You are the voice of the passage the reader is in. Answer their question about the quoted ' +
    'line warmly and concretely, drawing ONLY on the PASSAGES. If the passages do not support an ' +
    'answer, set grounded=false and gently say you can only speak to what is on the page. ' +
    (lang === 'hi' ? 'Answer in Hindi (Devanagari).' : 'Answer in plain English.');

  const prompt =
    `QUOTED LINE: "${quote}"\nQUESTION: ${question}\n\nPASSAGES:\n${groundingBlock(chunks)}`;

  const answer = await generateStructured(LineAnswer, { system, prompt, temperature: 0.6 });

  await db.rpc('log_event', { p_type: 'ask_line', p_kind: kind, p_item: id, p_payload: { quote } });

  return c.json(answer);
});

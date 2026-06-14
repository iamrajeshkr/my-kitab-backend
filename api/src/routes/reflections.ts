import { Hono } from 'hono';
import type { AppBindings } from '../middleware/auth.js';
import { ReflectionReq, ReflectionAnalysis } from '../lib/schemas.js';
import { generateStructured, embedText, toVectorLiteral } from '../lib/ai.js';
import { detectDistress, crisisResources } from '../lib/safety.js';
import { logger } from '../lib/logger.js';

export const reflections = new Hono<AppBindings>();

// POST /v1/reflections — store a "one line back", then enrich it: embedding +
// sentiment/themes + safety, fan out into companion memory, and surface crisis
// resources when needed. Persisted first so a slow LLM never loses the user's words.
reflections.post('/', async (c) => {
  const { text, lang, context } = ReflectionReq.parse(await c.req.json());
  const db = c.get('db');
  const userId = c.get('userId');

  const { data: inserted, error } = await db
    .from('reflections')
    .insert({ user_id: userId, text, lang, context })
    .select('id')
    .single();
  if (error) throw error;
  const reflectionId = inserted!.id as number;

  // Keyword fast-path can't miss the acute cases; LLM adds nuance.
  const [keyword, analysis, embedding] = await Promise.all([
    detectDistress(text),
    generateStructured(ReflectionAnalysis, {
      temperature: 0,
      system:
        'Analyse this private journal reflection. Return sentiment (-1..1), up to 5 short themes, ' +
        'a safety severity (0..3), and one durable memory worth keeping about the writer (or null).',
      prompt: text,
    }).catch((e) => {
      logger.warn({ e }, 'reflection analysis failed');
      return null;
    }),
    embedText(text),
  ]);

  const severity = Math.max(keyword.severity, analysis?.safety.severity ?? 0) as 0 | 1 | 2 | 3;

  await db
    .from('reflections')
    .update({
      sentiment: analysis?.sentiment ?? null,
      themes: analysis?.themes ?? [],
      embedding: toVectorLiteral(embedding),
      safety_severity: severity,
    })
    .eq('id', reflectionId);

  // Companion memory: a small, retrievable, user-visible fact.
  if (analysis?.memory) {
    const memEmbedding = await embedText(analysis.memory.text);
    await db.from('memories').insert({
      user_id: userId,
      kind: analysis.memory.kind,
      text: analysis.memory.text,
      embedding: toVectorLiteral(memEmbedding),
      source: { reflection_id: reflectionId },
      salience: 0.6,
    });
  }

  await db.rpc('log_event', { p_type: 'reflection', p_payload: { reflection_id: reflectionId } });

  // Step back: log the flag and hand off to real help.
  if (severity >= 2) {
    await db.from('safety_flags').insert({
      user_id: userId,
      source: 'reflection',
      severity,
      signals: { keyword: keyword.signals, llm: analysis?.safety.signals ?? [] },
      action: 'resources_shown',
    });
    return c.json({ id: reflectionId, safety: { severity, resources: crisisResources(lang) } });
  }

  return c.json({ id: reflectionId, safety: { severity } });
});

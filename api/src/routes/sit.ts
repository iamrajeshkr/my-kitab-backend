import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../middleware/auth.js';
import { SitPlan } from '../lib/schemas.js';
import { generateStructured } from '../lib/ai.js';

export const sit = new Hono<AppBindings>();

const SitReq = z.object({
  weather: z.enum(['heavy', 'restless', 'cloudy', 'clear', 'bright']),
  lang: z.enum(['en', 'hi']).default('en'),
});

// POST /v1/sit — build today's six-minute sit: Arrive → Read → Reflect → Carry.
// The read item comes from the recommender (weather-aware); the breath/prompt/
// practice are composed. Idempotent per (user, date).
sit.post('/', async (c) => {
  const { weather, lang } = SitReq.parse(await c.req.json());
  const db = c.get('db');
  const userId = c.get('userId');

  const { data: recs } = await c.get('adminDb').rpc('recommend_for_user', {
    p_user: userId,
    p_weather: weather,
    p_limit: 1,
  });
  const read = (recs ?? [])[0] ?? null;

  const plan = await generateStructured(SitPlan, {
    temperature: 0.7,
    system:
      'Design a tiny contemplative "sit". Give: a one-line breathing cue (arrive), a single ' +
      'reflection prompt, and one concrete micro-practice to carry into tomorrow. Keep each under ' +
      '20 words. ' + (lang === 'hi' ? 'Write in Hindi.' : 'Write in plain English.'),
    prompt: `The reader feels: ${weather}. The reading is: ${read?.title ?? 'a short page'}.`,
  });

  const fullPlan = {
    arrive: plan.arrive,
    read: read ? { kind: read.kind, id: read.id, title: read.title } : null,
    reflect: plan.reflect_prompt,
    carry: plan.carry,
  };

  const today = new Date().toISOString().slice(0, 10);
  const { data: saved, error } = await db
    .from('sits')
    .upsert({ user_id: userId, for_date: today, weather, plan: fullPlan }, { onConflict: 'user_id,for_date' })
    .select('*')
    .single();
  if (error) throw error;
  return c.json(saved);
});

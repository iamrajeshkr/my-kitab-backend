import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../middleware/auth.js';
import { generateStructured } from '../lib/ai.js';

export const letter = new Hono<AppBindings>();

const Letter = z.object({ body: z.string() });

function weekStart(): string {
  const d = new Date();
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

// GET /v1/letter — the most recent letter from Kitab.
letter.get('/', async (c) => {
  const { data } = await c.get('db')
    .from('letters').select('*').order('week_start', { ascending: false }).limit(1).maybeSingle();
  return c.json({ letter: data ?? null });
});

// POST /v1/letter/generate — write this week's warm, personal letter from the
// week's signals. One per (user, week, lang). Typically called by a Sunday cron.
letter.post('/generate', async (c) => {
  const db = c.get('db');
  const lang = (c.req.query('lang') === 'hi' ? 'hi' : 'en') as 'en' | 'hi';
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const [reflectionsRes, weatherRes, gardenRes] = await Promise.all([
    db.from('reflections').select('text, themes').gte('created_at', since).limit(20),
    db.rpc('weather_trend', { p_user: c.get('userId'), p_days: 7 }),
    db.rpc('garden_summary', { p_user: c.get('userId') }),
  ]);

  const prompt =
    `WEATHER this week (oldest→newest): ${JSON.stringify(weatherRes.data ?? [])}\n` +
    `GARDEN: ${JSON.stringify(gardenRes.data ?? {})}\n` +
    `REFLECTIONS:\n${((reflectionsRes.data ?? []) as Array<{ text: string }>).map((r) => `- ${r.text}`).join('\n')}`;

  const out = await generateStructured(Letter, {
    temperature: 0.8,
    system:
      'Write a short, warm letter (4–6 sentences) from "Kitab" to the reader, narrating their ' +
      'week back to them — name the storms and the returns, one line that moved them, and one ' +
      'honest note of progress. Sign off "— Kitab". ' +
      (lang === 'hi' ? 'Write in Hindi (Devanagari).' : 'Write in plain, tender English.'),
    prompt,
  });

  const { data: saved, error } = await db
    .from('letters')
    .upsert(
      { user_id: c.get('userId'), week_start: weekStart(), lang, body: out.body, model: 'gemini' },
      { onConflict: 'user_id,week_start,lang' }
    )
    .select('*')
    .single();
  if (error) throw error;
  return c.json(saved);
});

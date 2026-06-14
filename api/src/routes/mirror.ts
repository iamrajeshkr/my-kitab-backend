import { Hono } from 'hono';
import type { AppBindings } from '../middleware/auth.js';
import { MirrorPortrait } from '../lib/schemas.js';
import { generateStructured } from '../lib/ai.js';

export const mirror = new Hono<AppBindings>();

// Monday of the current week (UTC) as an ISO date — the snapshot key.
function weekStart(): string {
  const d = new Date();
  const day = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

// GET /v1/mirror — latest portrait + the first one, so the client can render
// the "week 1 -> now" delta without recomputation.
mirror.get('/', async (c) => {
  const db = c.get('db');
  const [{ data: latest }, { data: first }] = await Promise.all([
    db.from('mirror_snapshots').select('*').order('week_start', { ascending: false }).limit(1).maybeSingle(),
    db.from('mirror_snapshots').select('week_start, traits, portrait').order('week_start', { ascending: true }).limit(1).maybeSingle(),
  ]);
  return c.json({ latest: latest ?? null, first: first ?? null });
});

// POST /v1/mirror/generate — compose this week's self-portrait from the user's
// signals. Idempotent per week (upsert on (user, week_start)).
mirror.post('/generate', async (c) => {
  const db = c.get('db');
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const [reflectionsRes, weatherRes, gardenRes, firstRes] = await Promise.all([
    db.from('reflections').select('text, themes, sentiment').gte('created_at', since).order('created_at', { ascending: false }).limit(40),
    db.from('weather_checkins').select('weather').gte('created_at', since),
    db.rpc('garden_summary', { p_user: c.get('userId') }),
    db.from('mirror_snapshots').select('traits').order('week_start', { ascending: true }).limit(1).maybeSingle(),
  ]);

  const reflections = (reflectionsRes.data ?? []) as Array<{ text: string; themes: string[]; sentiment: number | null }>;
  const weatherCounts: Record<string, number> = {};
  for (const w of (weatherRes.data ?? []) as Array<{ weather: string }>) {
    weatherCounts[w.weather] = (weatherCounts[w.weather] ?? 0) + 1;
  }

  const prompt =
    `WEATHER over 30 days: ${JSON.stringify(weatherCounts)}\n` +
    `GARDEN: ${JSON.stringify(gardenRes.data ?? {})}\n` +
    `RECENT REFLECTIONS (themes + lines):\n` +
    reflections.slice(0, 20).map((r) => `- [${(r.themes ?? []).join(', ')}] ${r.text}`).join('\n');

  const portrait = await generateStructured(MirrorPortrait, {
    temperature: 0.7,
    system:
      'You compose a gentle, literary "self-portrait" of who the reader is becoming, in 2–3 ' +
      'sentences, second person, never clinical. ALWAYS return 3–6 traits scored 0..1 (e.g. ' +
      'steadiness, openness, self_compassion, presence) — never an empty set; estimate gently ' +
      'from sparse signals. If FIRST_TRAITS are given, note one honest, encouraging shift ' +
      'in delta_note; else null.',
    prompt: prompt + `\nFIRST_TRAITS: ${JSON.stringify(firstRes.data?.traits ?? null)}`,
  });

  const { data: saved, error } = await db
    .from('mirror_snapshots')
    .upsert(
      {
        user_id: c.get('userId'),
        week_start: weekStart(),
        portrait: portrait.portrait,
        traits: portrait.traits,
        deltas: portrait.delta_note ? { note: portrait.delta_note } : {},
        source_window: { reflections: reflections.length, weather: weatherCounts },
        model: 'gemini',
      },
      { onConflict: 'user_id,week_start' }
    )
    .select('*')
    .single();
  if (error) throw error;
  return c.json(saved);
});

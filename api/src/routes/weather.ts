import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../middleware/auth.js';

export const weather = new Hono<AppBindings>();

const WeatherReq = z.object({
  weather: z.enum(['heavy', 'restless', 'cloudy', 'clear', 'bright']),
  note: z.string().max(500).optional(),
  local_hour: z.number().int().min(0).max(23).optional(),
});

// POST /v1/weather — record an inner-weather check-in. Lands in weather_checkins
// (what weather_trend / the Mirror read) and also logs an event for the timeline.
weather.post('/', async (c) => {
  const b = WeatherReq.parse(await c.req.json());
  const db = c.get('db');
  const { error } = await db.from('weather_checkins').insert({
    user_id: c.get('userId'),
    weather: b.weather,
    note: b.note ?? null,
    local_hour: b.local_hour ?? null,
  });
  if (error) throw error;
  await db.rpc('log_event', { p_type: 'weather_checkin', p_payload: { weather: b.weather } });
  return c.json({ ok: true });
});

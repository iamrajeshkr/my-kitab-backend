import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../middleware/auth.js';

export const profile = new Hono<AppBindings>();

// GET /v1/profile — the signed-in user's profile.
profile.get('/', async (c) => {
  const { data } = await c.get('db').from('profiles').select('display_name, avatar_url, username').eq('id', c.get('userId')).maybeSingle();
  return c.json({ display_name: data?.display_name ?? null, avatar_url: data?.avatar_url ?? null, username: data?.username ?? null });
});

// PATCH /v1/profile { display_name } — update the display name.
profile.patch('/', async (c) => {
  const { display_name } = z.object({ display_name: z.string().trim().min(1).max(80) }).parse(await c.req.json());
  const { error } = await c.get('db').from('profiles').update({ display_name }).eq('id', c.get('userId'));
  if (error) throw error;
  return c.json({ display_name });
});

// POST /v1/profile/avatar { data, content_type } — base64 image → Storage (service
// key) → save avatar_url. The app talks to Supabase only via this API, so the
// upload happens server-side rather than against Storage RLS.
profile.post('/avatar', async (c) => {
  const { data, content_type } = z.object({ data: z.string().min(1), content_type: z.string().optional() }).parse(await c.req.json());
  const admin = c.get('adminDb');
  const userId = c.get('userId');
  const b64 = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
  const buf = Buffer.from(b64, 'base64');
  const ext = (content_type ?? 'image/jpeg').includes('png') ? 'png' : 'jpg';
  const path = `${userId}/avatar.${ext}`;

  const up = await admin.storage.from('avatars').upload(path, buf, { contentType: content_type ?? 'image/jpeg', upsert: true });
  if (up.error) throw up.error;

  const base = admin.storage.from('avatars').getPublicUrl(path).data.publicUrl;
  const avatar_url = `${base}?v=${Date.now()}`; // bust the CDN cache on re-upload
  const { error } = await admin.from('profiles').update({ avatar_url }).eq('id', userId);
  if (error) throw error;
  return c.json({ avatar_url });
});

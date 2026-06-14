import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../middleware/auth.js';
import { admin } from '../lib/supabase.js';
import { mintAccessToken } from '../lib/token.js';

// PUBLIC routes (no auth middleware) — this is how a user comes into existence.
// Guest-first: the client sends a stable device_id; we upsert a profile and mint
// a long-lived token. No email, no password, no verification. The user can link
// an email later to move off a single device.
export const authPublic = new Hono<AppBindings>();

const GuestReq = z.object({
  device_id: z.string().min(8).max(128).optional(),
  display_name: z.string().max(80).optional(),
  language: z.enum(['en', 'hi']).optional(),
});

authPublic.post('/guest', async (c) => {
  const body = GuestReq.parse(await c.req.json().catch(() => ({})));

  let userId: string;
  if (body.device_id) {
    // Returning device → same user (idempotent sign-in).
    const { data, error } = await admin
      .from('profiles')
      .upsert(
        { device_id: body.device_id, display_name: body.display_name ?? null, language: body.language ?? 'en' },
        { onConflict: 'device_id', ignoreDuplicates: false }
      )
      .select('id')
      .single();
    if (error) throw error;
    userId = data!.id as string;
  } else {
    const { data, error } = await admin
      .from('profiles')
      .insert({ display_name: body.display_name ?? null, language: body.language ?? 'en' })
      .select('id')
      .single();
    if (error) throw error;
    userId = data!.id as string;
  }

  const token = await mintAccessToken(userId);
  return c.json({ userId, token });
});

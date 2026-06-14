import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../middleware/auth.js';
import { admin } from '../lib/supabase.js';
import { mintAccessToken } from '../lib/token.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { SignupReq, SigninReq, ComposedPage } from '../lib/schemas.js';
import { retrieve, groundingBlock } from '../lib/rag.js';
import { generateStructured } from '../lib/ai.js';

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

// Username + password account creation. No email, no verification.
authPublic.post('/signup', async (c) => {
  const { username, password, display_name } = SignupReq.parse(await c.req.json());
  const uname = username.trim().toLowerCase();

  const { data: existing } = await admin.from('profiles').select('id').eq('username', uname).maybeSingle();
  if (existing) return c.json({ error: 'That username is taken.' }, 409);

  const { data, error } = await admin
    .from('profiles')
    .insert({ username: uname, password_hash: hashPassword(password), display_name: display_name ?? username, is_guest: false })
    .select('id')
    .single();
  if (error) throw error;

  const token = await mintAccessToken(data!.id as string);
  return c.json({ userId: data!.id, token });
});

// PUBLIC preview compose — the value moment in onboarding, before an account
// exists. No memory, no logging. (Unauthenticated LLM call — fine at this scale;
// add per-IP rate limiting if it ever gets abused.)
const PreviewReq = z.object({
  weather: z.enum(['heavy', 'restless', 'cloudy', 'clear', 'bright']).optional(),
  intent: z.string().max(280).optional(),
  lang: z.enum(['en', 'hi']).default('en'),
});
authPublic.post('/preview-page', async (c) => {
  const { weather, intent, lang } = PreviewReq.parse(await c.req.json().catch(() => ({})));
  const query =
    [weather ? `feeling ${weather}` : '', intent ?? ''].filter(Boolean).join('. ') ||
    'beginning a practice of calm';
  const chunks = await retrieve(query, lang, { k: 6 });
  const system =
    'You are Kitab, a warm, literary companion. Write ONE short original page (1–2 short ' +
    'paragraphs) for the reader, grounded in the PASSAGES — do not invent teachings. ' +
    (lang === 'hi' ? 'Write in natural Hindi.' : 'Write in calm, plain English.');
  const page = await generateStructured(ComposedPage, {
    system,
    prompt: `READER: ${query}\n\nPASSAGES:\n${groundingBlock(chunks)}`,
    temperature: 0.7,
  });
  return c.json({ title: page.title, paragraphs: page.paragraphs });
});

// Sign in with username + password.
authPublic.post('/signin', async (c) => {
  const { username, password } = SigninReq.parse(await c.req.json());
  const uname = username.trim().toLowerCase();

  const { data } = await admin.from('profiles').select('id, password_hash').eq('username', uname).maybeSingle();
  if (!data || !verifyPassword(password, data.password_hash as string | null)) {
    return c.json({ error: 'Wrong username or password.' }, 401);
  }
  const token = await mintAccessToken(data.id as string);
  return c.json({ userId: data.id, token });
});

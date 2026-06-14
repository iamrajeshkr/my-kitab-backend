import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { jwtVerify } from 'jose';
import { env } from '../env.js';
import { userClient, admin } from '../lib/supabase.js';
import type { SupabaseClient } from '@supabase/supabase-js';

export type AppBindings = {
  Variables: {
    userId: string;
    jwt: string;
    db: SupabaseClient;   // RLS-scoped to the caller
    adminDb: SupabaseClient;
  };
};

const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);

// Verify the Supabase JWT locally (HS256) — no auth round trip on the hot path.
export const auth = createMiddleware<AppBindings>(async (c, next) => {
  const header = c.req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HTTPException(401, { message: 'missing bearer token' });

  let sub: string;
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    if (!payload.sub) throw new Error('no sub');
    sub = payload.sub;
  } catch {
    throw new HTTPException(401, { message: 'invalid token' });
  }

  c.set('userId', sub);
  c.set('jwt', token);
  c.set('db', userClient(token));
  c.set('adminDb', admin);
  await next();
});

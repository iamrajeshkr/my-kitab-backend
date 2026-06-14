import { SignJWT } from 'jose';
import { env } from '../env.js';

const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);

// Mint an access token the backend controls — no Supabase Auth involved. It's
// signed with the project JWT secret and shaped like a Supabase token (sub +
// role=authenticated), so PostgREST validates it and RLS resolves auth.uid()
// to this user. The same secret is what middleware/auth.ts verifies.
export async function mintAccessToken(userId: string, ttl = '30d'): Promise<string> {
  return await new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secret);
}

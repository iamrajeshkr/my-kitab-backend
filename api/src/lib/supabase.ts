import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../env.js';

// Admin client — bypasses RLS. Use ONLY for cross-user work the API legitimately
// owns: CF reads, resonance aggregates, generating Mirror/letter artifacts, the
// embedding backfill. Never hand it a raw user-supplied filter without scoping.
export const admin: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Per-request client carrying the caller's JWT, so PostgREST enforces RLS as
// that user. This is the default for anything user-scoped — defence in depth:
// even an API bug can't read another user's rows.
export function userClient(jwt: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

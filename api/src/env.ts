import 'dotenv/config';
import { z } from 'zod';

// Fail fast at boot if the environment is misconfigured — never at request time.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8787),

  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_KEY: z.string().min(1),
  // HS256 secret used to verify Supabase auth JWTs locally (no network hop).
  SUPABASE_JWT_SECRET: z.string().min(1),

  // LLM provider. Keys live ONLY here — never in the Expo client.
  GEMINI_API_KEY: z.string().min(1),
  CHAT_MODEL: z.string().default('gemini-2.5-flash'),
  EMBEDDING_MODEL: z.string().default('gemini-embedding-001'),
  EMBEDDING_DIM: z.coerce.number().default(768),
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;

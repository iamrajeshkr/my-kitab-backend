import { z } from 'zod';

// All LLM output is forced through these schemas via generateObject, so the
// model retries on malformed output and call sites get validated data — never
// hand-parsed JSON (the bug pattern in the old client gemini.ts).

export const ComposedPage = z.object({
  title: z.string(),
  paragraphs: z.array(z.string()).min(1).max(5),
  // chunk ids the page is grounded in — validated against what we retrieved.
  citations: z.array(z.number().int()).default([]),
});
export type ComposedPage = z.infer<typeof ComposedPage>;

export const LineAnswer = z.object({
  answer: z.string(),
  // false => model couldn't ground it in the passage; client shows a soft fallback.
  grounded: z.boolean(),
});

export const ReflectionAnalysis = z.object({
  sentiment: z.number().min(-1).max(1),
  themes: z.array(z.string()).max(5),
  // severity: 0 none, 1 mild, 2 elevated, 3 crisis.
  safety: z.object({ severity: z.number().int().min(0).max(3), signals: z.array(z.string()) }),
  // a durable fact worth remembering, or null if nothing notable.
  memory: z.object({ text: z.string(), kind: z.enum(['fact', 'preference', 'theme', 'milestone']) }).nullable(),
});

export const MirrorPortrait = z.object({
  portrait: z.string(),
  traits: z.record(z.string(), z.number().min(0).max(1)),
  delta_note: z.string().nullable(),
});

export const SitPlan = z.object({
  arrive: z.string(),
  reflect_prompt: z.string(),
  carry: z.string(),
});

// ---- request bodies -------------------------------------------------------
export const ComposeReq = z.object({
  weather: z.enum(['heavy', 'restless', 'cloudy', 'clear', 'bright']),
  intent: z.string().max(280).optional(),
  lang: z.enum(['en', 'hi']).default('en'),
});

export const AskReq = z.object({
  kind: z.enum(['byte', 'journey', 'summary']),
  id: z.string().uuid(),
  lang: z.enum(['en', 'hi']).default('en'),
  quote: z.string().min(1).max(1000),
  question: z.string().max(500).default('What does this mean for me tonight?'),
});

export const ReflectionReq = z.object({
  text: z.string().min(1).max(4000),
  lang: z.enum(['en', 'hi']).default('en'),
  context: z.record(z.string(), z.unknown()).default({}),
});

export const SearchReq = z.object({
  q: z.string().min(1).max(300),
  lang: z.enum(['en', 'hi']).default('en'),
  limit: z.number().int().min(1).max(30).default(10),
});

export const RecommendReq = z.object({
  weather: z.enum(['heavy', 'restless', 'cloudy', 'clear', 'bright']).optional(),
  limit: z.number().int().min(1).max(30).default(10),
});

export const SignupReq = z.object({
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_.]+$/, 'letters, numbers, _ or . only'),
  password: z.string().min(6).max(128),
  display_name: z.string().max(80).optional(),
});

export const SigninReq = z.object({
  username: z.string().min(1).max(32),
  password: z.string().min(1).max(128),
});

export const CompanionReq = z.object({
  query: z.string().min(1).max(500),
  lang: z.enum(['en', 'hi']).default('en'),
  history: z.array(z.object({ role: z.enum(['user', 'model']), text: z.string() })).max(10).default([]),
});

export const CompanionReply = z.object({
  reply: z.string(),
  item_ids: z.array(z.string()).max(3).default([]),
});

export const EventsReq = z.object({
  events: z.array(z.object({
    type: z.string(),
    kind: z.enum(['byte', 'journey', 'summary']).optional(),
    id: z.string().uuid().optional(),
    payload: z.record(z.string(), z.unknown()).default({}),
  })).min(1).max(100),
});

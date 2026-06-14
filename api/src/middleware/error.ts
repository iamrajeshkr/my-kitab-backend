import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { logger } from '../lib/logger.js';

// Single error funnel: known HTTP errors and validation errors get clean
// status codes; everything else is logged and returned as a generic 500 (never
// leak internals to the client).
export function onError(err: Error, c: Context): Response {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  if (err instanceof ZodError) {
    return c.json({ error: 'invalid request', details: err.flatten() }, 422);
  }
  logger.error({ err }, 'unhandled error');
  return c.json({ error: 'internal error' }, 500);
}

import pino from 'pino';
import { env } from '../env.js';

export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: ['req.headers.authorization', '*.embedding'], // never log tokens or vectors
});

// Lightweight timer for measuring + logging LLM / DB latency.
export function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  return fn().finally(() =>
    logger.debug({ op: name, ms: Math.round(performance.now() - start) }, 'timing')
  );
}

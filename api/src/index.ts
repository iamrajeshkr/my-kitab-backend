import { serve } from '@hono/node-server';
import app from './app.js';
import { env } from './env.js';
import { logger } from './lib/logger.js';

// Local / persistent-Node hosting (Railway, Render, Fly, a VM). For Vercel's
// serverless model the entrypoint is api/index.ts instead — same app.
serve({ fetch: app.fetch, port: env.PORT }, (info) =>
  logger.info(`kitab-api listening on :${info.port}`)
);

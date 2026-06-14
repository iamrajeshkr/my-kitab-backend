import { handle } from '@hono/node-server/vercel';
import app from '../src/app.js';

// Vercel Node.js Serverless Function entrypoint. vercel.json rewrites every
// path to here, so the Hono app handles its own routing. Local dev does NOT use
// this file (see src/index.ts).
export default handle(app);

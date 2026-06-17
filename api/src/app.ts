import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { swaggerUI } from '@hono/swagger-ui';
import { openapiSpec } from './openapi.js';
import { auth, type AppBindings } from './middleware/auth.js';
import { onError } from './middleware/error.js';

import { authPublic } from './routes/auth.js';
import { compose } from './routes/compose.js';
import { ask } from './routes/ask.js';
import { reflections } from './routes/reflections.js';
import { recommend } from './routes/recommend.js';
import { search } from './routes/search.js';
import { events } from './routes/events.js';
import { mirror } from './routes/mirror.js';
import { letter } from './routes/letter.js';
import { sit } from './routes/sit.js';
import { weather } from './routes/weather.js';
import { practices } from './routes/practices.js';
import { garden } from './routes/garden.js';
import { companion } from './routes/companion.js';
import { catalog } from './routes/catalog.js';
import { progress } from './routes/progress.js';
import { threads } from './routes/threads.js';
import { highlights } from './routes/highlights.js';
import { arcs } from './routes/arcs.js';
import { similar } from './routes/similar.js';
import { playlists } from './routes/playlists.js';
import { home } from './routes/home.js';

// The configured Hono app — no server binding here. Local dev wraps it in
// @hono/node-server (src/index.ts); Vercel wraps it in @hono/node-server/vercel
// (api/index.ts). Same route tree both ways.
export const app = new Hono<AppBindings>();

app.use('*', honoLogger());
app.use('*', cors()); // allow the Expo (web) origin to call the API
app.onError(onError);

// Unauthenticated liveness probe.
app.get('/health', (c) => c.json({ ok: true, service: 'kitab-api' }));

// Interactive API docs — Swagger UI at /docs, served from the OpenAPI spec.
app.get('/openapi.json', (c) => c.json(openapiSpec));
app.get('/docs', swaggerUI({ url: '/openapi.json' }));

// Public auth (user creation + token minting). Registered before the guarded
// group so /v1/auth/* is reachable without a token.
app.route('/v1/auth', authPublic);

// Everything else under /v1 requires a valid (backend-minted) JWT.
const v1 = new Hono<AppBindings>();
v1.use('*', auth);
v1.route('/compose-page', compose);
v1.route('/ask-line', ask);
v1.route('/reflections', reflections);
v1.route('/recommend', recommend);
v1.route('/search', search);
v1.route('/events', events);
v1.route('/mirror', mirror);
v1.route('/letter', letter);
v1.route('/sit', sit);
v1.route('/weather', weather);
v1.route('/practices', practices);
v1.route('/garden', garden);
v1.route('/companion', companion);
v1.route('/catalog', catalog);
v1.route('/progress', progress);
v1.route('/threads', threads);
v1.route('/highlights', highlights);
v1.route('/arcs', arcs);
v1.route('/similar', similar);
v1.route('/playlists', playlists);
v1.route('/home', home);
app.route('/v1', v1);

export default app;

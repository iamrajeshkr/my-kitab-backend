// Hand-authored OpenAPI 3.0 spec (served at /openapi.json, rendered by Swagger
// UI at /docs). Kept in sync with the routes by hand. servers:'/' so "Try it
// out" calls the same origin (works locally and on Vercel).

const weather = { type: 'string', enum: ['heavy', 'restless', 'cloudy', 'clear', 'bright'] };
const lang = { type: 'string', enum: ['en', 'hi'], default: 'en' };
const kind = { type: 'string', enum: ['byte', 'journey', 'summary'] };
const jsonBody = (properties: Record<string, unknown>, required: string[] = []) => ({
  required: true,
  content: { 'application/json': { schema: { type: 'object', properties, required } } },
});
const ok = { '200': { description: 'OK' } };
const secured = [{ bearerAuth: [] }];

export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Bingent API',
    version: '0.1.0',
    description:
      'AI control plane. Get a token from POST /v1/auth/guest, click **Authorize**, paste it, ' +
      'then "Try it out" on any endpoint.',
  },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
  },
  security: secured, // default: most endpoints need a token
  paths: {
    '/health': { get: { tags: ['public'], summary: 'Liveness', security: [], responses: ok } },

    '/v1/auth/guest': {
      post: {
        tags: ['public'], summary: 'Create guest user + mint token', security: [],
        requestBody: jsonBody({ device_id: { type: 'string' }, display_name: { type: 'string' }, language: lang }),
        responses: { '200': { description: 'userId + token' } },
      },
    },

    '/v1/compose-page': {
      post: {
        tags: ['ai'], summary: "Tonight's page (RAG + sources)",
        requestBody: jsonBody({ weather, intent: { type: 'string' }, lang }, ['weather']), responses: ok,
      },
    },
    '/v1/ask-line': {
      post: {
        tags: ['ai'], summary: 'Answer about a highlighted line',
        requestBody: jsonBody({ kind, id: { type: 'string', format: 'uuid' }, lang, quote: { type: 'string' }, question: { type: 'string' } }, ['kind', 'id', 'quote']),
        responses: ok,
      },
    },
    '/v1/companion': {
      post: {
        tags: ['ai'], summary: 'Ask Bingent — reply + recommendations',
        requestBody: jsonBody({ query: { type: 'string' }, lang, history: { type: 'array', items: { type: 'object' } } }, ['query']),
        responses: ok,
      },
    },
    '/v1/recommend': {
      post: {
        tags: ['discovery'], summary: 'CF + weather-fit recommendations',
        requestBody: jsonBody({ weather, limit: { type: 'integer', default: 10 } }), responses: ok,
      },
    },
    '/v1/search': {
      post: {
        tags: ['discovery'], summary: 'Feeling-based semantic search',
        requestBody: jsonBody({ q: { type: 'string' }, lang, limit: { type: 'integer', default: 10 } }, ['q']),
        responses: ok,
      },
    },

    '/v1/reflections': {
      post: {
        tags: ['journal'], summary: 'Store + enrich a reflection',
        requestBody: jsonBody({ text: { type: 'string' }, lang, context: { type: 'object' } }, ['text']), responses: ok,
      },
    },
    '/v1/weather': {
      post: {
        tags: ['journal'], summary: 'Inner-weather check-in',
        requestBody: jsonBody({ weather, note: { type: 'string' }, local_hour: { type: 'integer' } }, ['weather']), responses: ok,
      },
    },
    '/v1/events': {
      post: {
        tags: ['journal'], summary: 'Batched event ingest',
        requestBody: jsonBody({ events: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, kind, id: { type: 'string' }, payload: { type: 'object' } } } } }, ['events']),
        responses: ok,
      },
    },

    '/v1/garden': { get: { tags: ['progress'], summary: 'Felt-progress summary', responses: ok } },
    '/v1/mirror': { get: { tags: ['progress'], summary: 'Latest + first portrait', responses: ok } },
    '/v1/mirror/generate': { post: { tags: ['progress'], summary: 'Compose this week\'s portrait', responses: ok } },
    '/v1/letter': { get: { tags: ['progress'], summary: 'Latest weekly letter', responses: ok } },
    '/v1/letter/generate': { post: { tags: ['progress'], summary: 'Write this week\'s letter', responses: ok } },
    '/v1/sit': {
      post: { tags: ['ritual'], summary: "Today's daily sit", requestBody: jsonBody({ weather, lang }, ['weather']), responses: ok },
    },
  },
} as const;

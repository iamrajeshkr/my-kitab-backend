import { Hono } from 'hono';
import type { AppBindings } from '../middleware/auth.js';

// Catalog reads go through the backend (service role) so the app doesn't need
// anon access to the content tables, and so we can coerce the double-encoded
// jsonb columns (content / content_chapterwise / audio / tags) once, server-side.

const JSON_FIELDS = ['content', 'audio', 'tags', 'content_chapterwise', 'title_bilingual', 'author_bilingual', 'feedback'];

function coerce<T extends Record<string, any>>(row: T): T {
  if (!row || typeof row !== 'object') return row;
  const out: Record<string, any> = { ...row };
  for (const f of JSON_FIELDS) {
    if (typeof out[f] === 'string') {
      try { out[f] = JSON.parse(out[f]); } catch { /* leave as-is */ }
    }
  }
  return out as T;
}

// PostgREST caps a select at 1000 rows — paginate so all bites come through.
async function fetchAll(admin: AppBindings['Variables']['adminDb'], table: string, cols: string) {
  const out: any[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await admin.from(table).select(cols).range(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return out.map(coerce);
}

const TABLE: Record<string, string> = { byte: 'bites', journey: 'journeys', summary: 'summaries' };

export const catalog = new Hono<AppBindings>();

// GET /v1/catalog — light columns for the shelf/discover lists.
catalog.get('/', async (c) => {
  const admin = c.get('adminDb');
  const [bites, journeys, summaries] = await Promise.all([
    fetchAll(admin, 'bites', 'id,cover,author,title,audio,difficulty,category,author_bilingual,title_bilingual'),
    fetchAll(admin, 'journeys', 'id,cover,author,title,tags'),
    fetchAll(admin, 'summaries', 'id,cover,author,title,audio'),
  ]);
  return c.json({ bites, journeys, summaries });
});

// GET /v1/catalog/:kind/:id — full item (coerced) for the detail screen.
catalog.get('/:kind/:id', async (c) => {
  const table = TABLE[c.req.param('kind')];
  if (!table) return c.json({ error: 'unknown kind' }, 400);
  const { data, error } = await c.get('adminDb').from(table).select('*').eq('id', c.req.param('id')).maybeSingle();
  if (error) throw error;
  if (!data) return c.json({ error: 'not found' }, 404);
  return c.json(coerce(data));
});

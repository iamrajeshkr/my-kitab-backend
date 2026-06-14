/**
 * Backfill / refresh content embeddings.
 *
 *   npm run backfill            # process the re-embedding queue (incremental)
 *   npm run backfill -- --all   # full re-scan of all content
 *
 * Idempotent: a chunk is only re-embedded when its content_hash changes, so
 * re-runs are cheap and embedding spend tracks actual content edits.
 */
import { createHash } from 'node:crypto';
import { admin } from '../lib/supabase.js';
import { embedBatch, toVectorLiteral } from '../lib/ai.js';
import { logger } from '../lib/logger.js';

type Kind = 'byte' | 'journey' | 'summary';
const TABLE: Record<Kind, string> = { byte: 'bites', journey: 'journeys', summary: 'summaries' };
const LANGS = ['en', 'hi'] as const;

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

// Pack paragraphs into ~1200-char chunks, keeping a heading with its body.
function chunkText(text: string, maxChars = 1200): { heading: string | null; text: string }[] {
  const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const out: { heading: string | null; text: string }[] = [];
  let buf = '';
  let heading: string | null = null;
  const flush = () => { if (buf.trim()) out.push({ heading, text: buf.trim() }); buf = ''; };
  for (const b of blocks) {
    const h = b.match(/^#{1,4}\s+(.*)$/);
    if (h) { flush(); heading = h[1] ?? null; continue; }
    if ((buf + '\n\n' + b).length > maxChars) flush();
    buf += (buf ? '\n\n' : '') + b;
  }
  flush();
  return out.length ? out : [{ heading: null, text: text.slice(0, maxChars) }];
}

// Some jsonb columns come back double-encoded (a JSON string, not an object).
// Coerce defensively so bites/journeys (string-encoded) chunk like summaries.
function asObj(v: unknown): Record<string, any> {
  if (v && typeof v === 'object') return v as Record<string, any>;
  if (typeof v === 'string') {
    try {
      const d = JSON.parse(v);
      return d && typeof d === 'object' ? d : {};
    } catch {
      return {};
    }
  }
  return {};
}

// Turn a content row into per-language chunks.
function rowToChunks(kind: Kind, row: any): { lang: string; idx: number; heading: string | null; text: string }[] {
  const result: { lang: string; idx: number; heading: string | null; text: string }[] = [];
  const chapterwise = asObj(row.content_chapterwise);
  const content = asObj(row.content);
  for (const lang of LANGS) {
    if (kind === 'journey' && chapterwise[lang]) {
      // Each chapter (key "sec.sub") is its own chunk.
      Object.entries(asObj(chapterwise[lang]) as Record<string, string>).forEach(([key, txt], i) => {
        if (txt?.trim()) result.push({ lang, idx: i, heading: key, text: txt });
      });
      continue;
    }
    const body: string | undefined = content[lang];
    if (body?.trim()) {
      chunkText(body).forEach((ch, i) => result.push({ lang, idx: i, ...ch }));
    }
  }
  return result;
}

async function processItem(kind: Kind, row: any) {
  const chunks = rowToChunks(kind, row);
  if (chunks.length === 0) return 0;

  // Skip chunks whose hash is unchanged.
  const { data: existing } = await admin
    .from('content_chunks')
    .select('lang, chunk_index, content_hash')
    .eq('item_kind', kind)
    .eq('item_id', row.id);
  const seen = new Map((existing ?? []).map((e: any) => [`${e.lang}:${e.chunk_index}`, e.content_hash]));

  const todo = chunks.filter((ch) => seen.get(`${ch.lang}:${ch.idx}`) !== sha1(ch.text));
  if (todo.length === 0) return 0;

  const vectors = await embedBatch(todo.map((t) => t.text));
  const rows = todo.map((t, i) => ({
    item_kind: kind,
    item_id: row.id,
    lang: t.lang,
    chunk_index: t.idx,
    heading: t.heading,
    text: t.text,
    token_estimate: Math.ceil(t.text.length / 4),
    content_hash: sha1(t.text),
    embedding: toVectorLiteral(vectors[i]!),
  }));
  // Write in small batches — a single upsert of 100+ vectors (plus HNSW index
  // work) can exceed the DB statement timeout (seen on long journeys).
  const WRITE = 40;
  for (let i = 0; i < rows.length; i += WRITE) {
    const { error } = await admin
      .from('content_chunks')
      .upsert(rows.slice(i, i + WRITE), { onConflict: 'item_kind,item_id,lang,chunk_index' });
    if (error) throw error;
  }
  return rows.length;
}

async function main() {
  const all = process.argv.includes('--all');
  // Optional: restrict to one content kind, e.g. --kind=journey (skips re-scanning
  // already-embedded tables).
  const kindArg = process.argv.find((a) => a.startsWith('--kind='))?.split('=')[1] as Kind | undefined;
  let total = 0;

  if (all) {
    const kinds = kindArg ? [kindArg] : (Object.keys(TABLE) as Kind[]);
    for (const kind of kinds) {
      // PostgREST caps a select at 1000 rows — paginate so large tables (bites)
      // are fully covered.
      const PAGE = 500;
      let from = 0;
      let scanned = 0;
      for (;;) {
        const { data, error } = await admin.from(TABLE[kind]).select('*').range(from, from + PAGE - 1);
        if (error) throw error;
        const rows = data ?? [];
        for (const row of rows) total += await processItem(kind, row);
        scanned += rows.length;
        if (rows.length < PAGE) break;
        from += PAGE;
      }
      logger.info({ kind, items: scanned }, 'scanned');
    }
  } else {
    const { data: queue } = await admin.from('content_embedding_queue').select('*').order('enqueued_at').limit(500);
    for (const q of queue ?? []) {
      const { data: row } = await admin.from(TABLE[q.item_kind as Kind]).select('*').eq('id', q.item_id).single();
      if (row) total += await processItem(q.item_kind, row);
      await admin.from('content_embedding_queue').delete().eq('item_kind', q.item_kind).eq('item_id', q.item_id);
    }
  }
  logger.info({ chunks_written: total }, 'backfill complete');
}

main().then(() => process.exit(0)).catch((e) => { logger.error({ e }, 'backfill failed'); process.exit(1); });

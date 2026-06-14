import { admin } from './supabase.js';
import { embedText, toVectorLiteral } from './ai.js';

export interface Chunk {
  item_kind: 'byte' | 'journey' | 'summary';
  item_id: string;
  chunk_index: number;
  heading: string | null;
  text: string;
  similarity: number;
  // synthesised stable id for citations: chunk rows have a bigint id, but the
  // RPC returns content fields; we expose the row id via a parallel lookup.
  id: number;
}

// Retrieve the nearest content chunks to a free-text query. Used by compose +
// ask-line. Runs against the HNSW index via the vector_search_content RPC.
export async function retrieve(
  query: string,
  lang: 'en' | 'hi',
  opts: { kinds?: Array<'byte' | 'journey' | 'summary'>; k?: number } = {}
): Promise<Chunk[]> {
  const embedding = await embedText(query);
  const { data, error } = await admin.rpc('vector_search_content', {
    query_embedding: toVectorLiteral(embedding),
    p_lang: lang,
    match_count: opts.k ?? 8,
    p_kinds: opts.kinds ?? null,
  });
  if (error) throw error;
  // The RPC doesn't return the bigint id; fetch ids for citation validation.
  return await attachIds(data ?? []);
}

// Retrieve passages from one specific item (for ask-this-line grounding).
export async function retrieveFromItem(
  kind: 'byte' | 'journey' | 'summary',
  id: string,
  lang: 'en' | 'hi'
): Promise<Chunk[]> {
  const { data, error } = await admin
    .from('content_chunks')
    .select('id, item_kind, item_id, chunk_index, heading, text')
    .eq('item_kind', kind)
    .eq('item_id', id)
    .eq('lang', lang)
    .order('chunk_index', { ascending: true })
    .limit(24);
  if (error) throw error;
  return (data ?? []).map((r) => ({ ...r, similarity: 1 })) as Chunk[];
}

async function attachIds(rows: Omit<Chunk, 'id'>[]): Promise<Chunk[]> {
  if (rows.length === 0) return [];
  // Resolve (kind,id,chunk_index) -> bigint id in one query.
  const keys = rows.map((r) => `${r.item_kind}:${r.item_id}:${r.chunk_index}`);
  const { data } = await admin
    .from('content_chunks')
    .select('id, item_kind, item_id, chunk_index')
    .in('item_id', [...new Set(rows.map((r) => r.item_id))]);
  const byKey = new Map((data ?? []).map((d) => [`${d.item_kind}:${d.item_id}:${d.chunk_index}`, d.id]));
  return rows.map((r, i) => ({ ...r, id: byKey.get(keys[i]!) ?? -1 }));
}

// Render chunks into a grounding block the model must cite from.
export function groundingBlock(chunks: Chunk[]): string {
  return chunks
    .map((c) => `[#${c.id}] ${c.heading ? c.heading + ' — ' : ''}${c.text}`)
    .join('\n\n');
}

// Keep only citations the model was actually given (anti-hallucination).
export function validateCitations(cited: number[], chunks: Chunk[]): number[] {
  const allowed = new Set(chunks.map((c) => c.id));
  return cited.filter((id) => allowed.has(id));
}

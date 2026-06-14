import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { embed, embedMany, generateText, Output } from 'ai';
import type { z } from 'zod';
import { env } from '../env.js';

// Single provider instance. Swap to Vercel AI Gateway here (one line) to get
// provider failover + cost tracking without touching call sites.
const google = createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY });

export const chatModel = google(env.CHAT_MODEL);
export const embeddingModel = google.textEmbeddingModel(env.EMBEDDING_MODEL);

// gemini-embedding-001 defaults to 3072 dims; we request EMBEDDING_DIM (768) to
// match the pgvector columns AND stay under pgvector's 2000-dim HNSW limit.
// taskType steers the embedding: documents at index time, queries at search time.
// We use cosine ops everywhere, which is scale-invariant, so reduced-dim vectors
// don't need manual re-normalisation.
type TaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' | 'SEMANTIC_SIMILARITY';
const embedOpts = (taskType: TaskType) => ({
  google: { outputDimensionality: env.EMBEDDING_DIM, taskType },
});

export async function embedText(text: string, taskType: TaskType = 'RETRIEVAL_QUERY'): Promise<number[]> {
  const { embedding } = await embed({ model: embeddingModel, value: text, providerOptions: embedOpts(taskType) });
  return embedding;
}

export async function embedBatch(values: string[], taskType: TaskType = 'RETRIEVAL_DOCUMENT'): Promise<number[][]> {
  if (values.length === 0) return [];
  // Gemini caps a batch at 100 inputs — split larger sets (e.g. long journeys).
  const MAX = 100;
  const out: number[][] = [];
  for (let i = 0; i < values.length; i += MAX) {
    const { embeddings } = await embedMany({
      model: embeddingModel,
      values: values.slice(i, i + MAX),
      providerOptions: embedOpts(taskType),
    });
    out.push(...embeddings);
  }
  return out;
}

// pgvector wants a bracketed literal: "[0.1,0.2,...]".
export const toVectorLiteral = (v: number[]): string => `[${v.join(',')}]`;

// Structured generation, AI SDK v6 style: generateText + Output.object. The
// schema both steers and validates the model, so call sites get typed data and
// the model retries on malformed output. One place to tune model/temperature.
export async function generateStructured<T>(
  schema: z.ZodType<T>,
  opts: { system?: string; prompt: string; temperature?: number }
): Promise<T> {
  const { output } = await generateText({
    model: chatModel,
    output: Output.object({ schema }),
    ...(opts.system ? { system: opts.system } : {}),
    prompt: opts.prompt,
    temperature: opts.temperature ?? 0.6,
  });
  return output as T;
}

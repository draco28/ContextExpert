/**
 * Embedder Orchestration
 *
 * Transforms ChunkResult[] into EmbeddedChunk[] by computing vector embeddings.
 * This is the bridge between the chunking pipeline and SQLite storage.
 *
 * Key responsibilities:
 * 1. Batch chunks for efficient embedding (default: 32 per batch)
 * 2. Convert SDK's number[] embeddings to Float32Array for BLOB storage
 * 3. Handle errors gracefully (skip bad chunks, continue processing)
 * 4. Report progress for long-running operations
 */

import type { EmbeddingProvider } from '@contextaisdk/rag';

import type { ChunkResult } from '../chunker/types.js';
import type { EmbeddedChunk, EmbedderOptions } from './types.js';

/** Default batch size - 32 is a good balance of speed vs memory */
const DEFAULT_BATCH_SIZE = 32;

/**
 * Error thrown when an embedding operation times out.
 */
export class EmbeddingTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Embedding operation timed out after ${timeoutMs}ms. ` +
      `This can happen if:\n` +
      `  - The embedding model is being downloaded (first run)\n` +
      `  - The Ollama server is slow to respond\n` +
      `  - Network issues with cloud embedding providers\n` +
      `Consider increasing timeout_ms in ~/.ctx/config.toml`
    );
    this.name = 'EmbeddingTimeoutError';
  }
}

/**
 * Embed a batch of text strings with optional timeout.
 *
 * Uses the provider's embedBatch method for efficiency.
 * If timeout is specified, the operation will abort after the timeout.
 */
async function embedBatch(
  provider: EmbeddingProvider,
  texts: string[],
  timeout?: number
): Promise<Float32Array[]> {
  // If no timeout, call directly
  if (!timeout) {
    const results = await provider.embedBatch(texts);
    return results.map((result) => new Float32Array(result.embedding));
  }

  // Use Promise.race to implement timeout
  // This works even if the provider doesn't support AbortController
  const embeddingPromise = provider.embedBatch(texts);
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new EmbeddingTimeoutError(timeout));
    }, timeout);
  });

  const results = await Promise.race([embeddingPromise, timeoutPromise]);

  // Convert number[] to Float32Array for SQLite BLOB storage
  return results.map((result) => new Float32Array(result.embedding));
}

/**
 * Process chunks in batches and compute embeddings.
 *
 * This is the main embedding function. It takes chunks from the chunking
 * pipeline and produces EmbeddedChunk[] ready for SQLite storage.
 *
 * @example
 * ```typescript
 * import { chunkFiles } from '../chunker';
 * import { createEmbeddingProvider, embedChunks } from '../embedder';
 *
 * // Get chunks from chunking pipeline
 * const chunks = await chunkFiles(files);
 *
 * // Create embedding provider from config
 * const provider = await createEmbeddingProvider(config.embedding);
 *
 * // Compute embeddings with progress reporting
 * const embeddedChunks = await embedChunks(chunks, provider, {
 *   batchSize: 32,
 *   onProgress: (done, total) => console.log(`${done}/${total} chunks embedded`),
 * });
 *
 * // embeddedChunks are ready for SQLite storage
 * ```
 *
 * @param chunks - Array of chunks from the chunking pipeline
 * @param provider - Embedding provider (from createEmbeddingProvider)
 * @param options - Batch size, progress callback, error handling
 * @returns Array of chunks with computed embeddings
 */
export async function embedChunks(
  chunks: ChunkResult[],
  provider: EmbeddingProvider,
  options: EmbedderOptions = {}
): Promise<EmbeddedChunk[]> {
  const {
    batchSize = DEFAULT_BATCH_SIZE,
    timeout,
    signal,
    onProgress,
    onError,
  } = options;

  // Handle empty input
  if (chunks.length === 0) {
    return [];
  }

  const embeddedChunks: EmbeddedChunk[] = [];
  let processed = 0;

  // Process in batches
  for (let i = 0; i < chunks.length; i += batchSize) {
    // Check for cancellation before each batch
    if (signal?.aborted) {
      // Return what we have so far (partial results)
      break;
    }

    const batch = chunks.slice(i, i + batchSize);
    const texts = batch.map((chunk) => chunk.content);

    try {
      // Get embeddings for this batch (with timeout if configured)
      const embeddings = await embedBatch(provider, texts, timeout);

      // Combine chunks with their embeddings
      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j]!; // Non-null assertion safe: j < batch.length
        const embedding = embeddings[j];

        // Validate embedding was computed
        if (!embedding || embedding.length === 0) {
          onError?.(
            new Error(`Empty embedding returned for chunk`),
            chunk.id
          );
          continue;
        }

        // Create EmbeddedChunk by combining chunk with embedding
        embeddedChunks.push({
          ...chunk,
          embedding,
        });
      }

      processed += batch.length;
      onProgress?.(processed, chunks.length);

      // Yield to event loop to keep REPL responsive
      await new Promise((resolve) => setImmediate(resolve));
    } catch (error) {
      // Batch failed - try individual chunks for better error isolation
      for (const chunk of batch) {
        // Check for cancellation during fallback processing
        if (signal?.aborted) {
          break;
        }

        try {
          const [embedding] = await embedBatch(provider, [chunk.content], timeout);

          if (embedding && embedding.length > 0) {
            embeddedChunks.push({
              ...chunk,
              embedding,
            });
          } else {
            onError?.(
              new Error(`Empty embedding returned`),
              chunk.id
            );
          }
        } catch (chunkError) {
          // Individual chunk failed - skip it
          onError?.(
            chunkError instanceof Error ? chunkError : new Error(String(chunkError)),
            chunk.id
          );
        }

        processed++;
        onProgress?.(processed, chunks.length);
      }
    }
  }

  return embeddedChunks;
}

/**
 * Embed a single chunk.
 *
 * Convenience function for embedding individual chunks.
 * For multiple chunks, use embedChunks() for better efficiency.
 *
 * @param chunk - A single chunk to embed
 * @param provider - Embedding provider
 * @returns The chunk with computed embedding, or null if embedding failed
 */
export async function embedChunk(
  chunk: ChunkResult,
  provider: EmbeddingProvider
): Promise<EmbeddedChunk | null> {
  try {
    const result = await provider.embed(chunk.content);
    const embedding = new Float32Array(result.embedding);

    return {
      ...chunk,
      embedding,
    };
  } catch {
    return null;
  }
}

/**
 * Estimate memory usage for embedding a batch of chunks.
 *
 * Useful for tuning batch sizes based on available memory.
 *
 * @param chunkCount - Number of chunks
 * @param dimensions - Embedding dimensions (1024 for BGE-large)
 * @returns Estimated memory in bytes
 */
export function estimateEmbeddingMemory(
  chunkCount: number,
  dimensions: number = 1024
): number {
  // Each embedding: dimensions × 4 bytes (Float32)
  // Plus overhead for array objects (~100 bytes per array)
  const embeddingSize = dimensions * 4 + 100;
  return chunkCount * embeddingSize;
}

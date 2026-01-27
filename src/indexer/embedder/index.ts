/**
 * Embedder Module
 *
 * Embedding generation pipeline for converting text chunks into vector embeddings.
 * Uses the ContextAI SDK providers (HuggingFace, Ollama) with caching and fallback.
 *
 * Usage:
 * ```typescript
 * import { createEmbeddingProvider, embedChunks } from './embedder';
 * import { chunkFiles } from './chunker';
 *
 * // 1. Create provider from config
 * const provider = await createEmbeddingProvider(config.embedding);
 *
 * // 2. Get chunks from chunking pipeline
 * const chunks = await chunkFiles(files);
 *
 * // 3. Compute embeddings
 * const embeddedChunks = await embedChunks(chunks, provider, {
 *   onProgress: (done, total) => console.log(`${done}/${total}`),
 * });
 *
 * // 4. Store in SQLite (embeddings are Float32Array, ready for BLOB)
 * for (const chunk of embeddedChunks) {
 *   db.insertChunk(chunk);
 * }
 * ```
 */

// Provider factory
export {
  createEmbeddingProvider,
  getModelDimensions,
} from './provider.js';

// Embedder orchestration
export {
  embedChunks,
  embedChunk,
  estimateEmbeddingMemory,
} from './embedder.js';

// Types
export type {
  EmbeddingConfig,
  EmbeddedChunk,
  EmbedderOptions,
  ProviderOptions,
  ModelLoadProgress,
  EmbeddingProvider,
  EmbeddingResult,
} from './types.js';

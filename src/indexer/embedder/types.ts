/**
 * Embedder Types
 *
 * Type definitions for the embedding generation pipeline.
 * We re-export SDK types and extend them with our project-specific needs.
 *
 * Architecture Decision:
 * - SDK provides EmbeddingProvider interface (HuggingFace, Ollama implementations)
 * - SDK embeddings return `number[]` but SQLite BLOB storage needs `Float32Array`
 * - We wrap SDK types rather than redefining to stay compatible with SDK updates
 */

// Re-export SDK types for consumers of this module
export type {
  EmbeddingProvider,
  EmbeddingResult,
} from '@contextaisdk/rag';

import type { ChunkResult } from '../chunker/types.js';
import type { Logger } from '../../utils/index.js';

/**
 * Embedding provider configuration.
 * Matches the [embedding] section in config.toml.
 *
 * Design: Support primary + fallback providers for resilience.
 * HuggingFace runs locally (no API cost) but requires model download.
 * Ollama is a good fallback if you have it running.
 */
export interface EmbeddingConfig {
  /** Primary embedding provider */
  provider: 'huggingface' | 'ollama' | 'openai';

  /** Model identifier (e.g., "BAAI/bge-large-en-v1.5" for HuggingFace) */
  model: string;

  /** Fallback provider if primary fails/unavailable */
  fallback_provider?: 'huggingface' | 'ollama' | 'openai';

  /** Fallback model */
  fallback_model?: string;

  /** Batch size for embedBatch calls (default: 32) */
  batch_size?: number;
}

/**
 * A chunk with its computed embedding, ready for SQLite storage.
 *
 * Why Float32Array?
 * - SDK returns `number[]` which is more general
 * - SQLite BLOB storage is most efficient with typed arrays
 * - Float32Array is the standard for ML embeddings (4 bytes per dimension)
 * - 1024 dimensions × 4 bytes = 4KB per embedding (vs 8KB for Float64)
 */
export interface EmbeddedChunk extends ChunkResult {
  /** Vector embedding as Float32Array for direct BLOB storage */
  embedding: Float32Array;
}

/**
 * Options for the embedChunks orchestration function.
 */
export interface EmbedderOptions {
  /**
   * Number of chunks to process per batch.
   * Higher = faster (fewer API calls), but more memory.
   * @default 32
   */
  batchSize?: number;

  /**
   * Timeout in milliseconds for embedding operations.
   * If a batch takes longer than this, it will be aborted.
   * @default 120000 (2 minutes)
   */
  timeout?: number;

  /**
   * Progress callback, fired after each batch completes.
   * @param processed - Number of chunks embedded so far
   * @param total - Total number of chunks to embed
   */
  onProgress?: (processed: number, total: number) => void;

  /**
   * Error callback for non-fatal errors (chunk skipped but processing continues).
   * @param error - The error that occurred
   * @param chunkId - ID of the chunk that failed
   */
  onError?: (error: Error, chunkId: string) => void;
}

/**
 * Progress information during model loading.
 * Passed through to HuggingFace's onProgress callback.
 */
export interface ModelLoadProgress {
  /** Current status message (e.g., "Downloading model...") */
  status: string;

  /** Progress percentage (0-100), if available */
  progress?: number;
}

/**
 * Options for creating an embedding provider.
 */
export interface ProviderOptions {
  /**
   * Callback for model download/loading progress.
   * HuggingFace models can be large (~1.3GB for BGE-large).
   */
  onProgress?: (progress: ModelLoadProgress) => void;

  /**
   * Logger for warnings (e.g., provider availability check failures).
   * Defaults to console logger if not provided.
   */
  logger?: Logger;
}

/**
 * Result from createEmbeddingProvider including metadata about the provider.
 *
 * Why return metadata alongside the provider?
 * - Callers need to know which model was actually used (primary vs fallback)
 * - Dimensions are needed for database tracking and search service initialization
 * - This avoids the caller having to re-derive this information
 */
export interface EmbeddingProviderResult {
  /** The embedding provider instance (wrapped with caching) */
  provider: import('@contextaisdk/rag').EmbeddingProvider;
  /** The model name that was actually used (may differ from config if fallback activated) */
  model: string;
  /** The embedding dimensions for this model (e.g., 1024 for BGE-large) */
  dimensions: number;
}

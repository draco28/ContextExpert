/**
 * Search Module
 *
 * Semantic vector search and BM25 keyword search for indexed projects.
 *
 * This module provides the foundation for search functionality:
 * - Dense (vector) search: Semantic similarity using embeddings
 * - Sparse (BM25) search: Exact keyword matching using term frequency
 *
 * @example
 * ```typescript
 * // Semantic search (finds related concepts)
 * import { createSearchService } from './search/index.js';
 * import { createEmbeddingProvider } from './indexer/embedder/provider.js';
 *
 * const provider = await createEmbeddingProvider(config.embedding);
 * const search = createSearchService(projectId, provider, config.search, {
 *   dimensions: 1024,
 * });
 * const results = await search.search('authentication middleware');
 *
 * // Keyword search (finds exact terms)
 * import { createBM25SearchService } from './search/index.js';
 *
 * const bm25 = createBM25SearchService(projectId, config.search);
 * const results = await bm25.search('PostgreSQL connection');
 * ```
 *
 * @packageDocumentation
 */

// Dense (vector) search service
export { SearchService, createSearchService } from './retriever.js';

// Sparse (BM25) search service
export { BM25SearchService, createBM25SearchService } from './bm25-retriever.js';

// Store management - Vector
export {
  VectorStoreManager,
  getVectorStoreManager,
  resetVectorStoreManager,
} from './store.js';

// Store management - BM25
export {
  BM25StoreManager,
  getBM25StoreManager,
  resetBM25StoreManager,
} from './bm25-store.js';

// Types
export type {
  SearchConfig,
  SearchServiceOptions,
  SearchQueryOptions,
  SearchResultWithContext,
  IndexBuildProgress,
  BM25Config,
  BM25ServiceOptions,
} from './types.js';

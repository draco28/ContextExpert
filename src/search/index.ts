/**
 * Search Module
 *
 * Semantic vector search, BM25 keyword search, and hybrid fusion for indexed projects.
 *
 * This module provides the foundation for search functionality:
 * - Dense (vector) search: Semantic similarity using embeddings
 * - Sparse (BM25) search: Exact keyword matching using term frequency
 * - Hybrid (fusion) search: RRF-based combination of dense and sparse
 *
 * @example
 * ```typescript
 * // Semantic search (finds related concepts)
 * import { createSearchService } from './search/index.js';
 *
 * const search = createSearchService(projectId, config.search, {
 *   dimensions: 1024,
 * });
 * const results = await search.search('authentication middleware');
 *
 * // Keyword search (finds exact terms)
 * import { createBM25SearchService } from './search/index.js';
 *
 * const bm25 = createBM25SearchService(projectId, config.search);
 * const results = await bm25.search('PostgreSQL connection');
 *
 * // Hybrid search (best of both worlds)
 * import { createFusionService } from './search/index.js';
 *
 * const hybrid = createFusionService(projectId, provider, config.search);
 * const results = await hybrid.search('database optimization');
 * ```
 *
 * @packageDocumentation
 */

// Dense (vector) search service
export { SearchService, createSearchService } from './retriever.js';

// Sparse (BM25) search service
export { BM25SearchService, createBM25SearchService } from './bm25-retriever.js';

// Hybrid (fusion) search service
export {
  FusionService,
  createFusionService,
  computeRRF,
  DEFAULT_RRF_K,
} from './fusion.js';

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

// Result formatting
export {
  formatResult,
  formatResults,
  formatResultJSON,
  formatResultsJSON,
  formatScore,
  truncateSnippet,
} from './formatter.js';

// Types
export type {
  SearchConfig,
  SearchServiceOptions,
  SearchQueryOptions,
  SearchResultWithContext,
  IndexBuildProgress,
  BM25Config,
  BM25ServiceOptions,
  FusionConfig,
  FusionServiceOptions,
  FormatOptions,
  FormattedResultJSON,
} from './types.js';
